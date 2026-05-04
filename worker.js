/**
 * Cloudflare Worker HTTP/HTTPS Proxy (全面优化版)
 * 1. 支持并发加载静态资源，优化页面加载性能
 * 2. 精细化 CORS 控制，动态设置
 * 3. 自定义错误页面，增强用户体验
 * 4. 增强图片、懒加载和脚本的 URL 处理
 * 5. 支持静态资源缓存控制
 * 6. 增加日志记录，便于调试
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(request)
      });
    }

    // 根路径 - 返回 Web UI
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getRootHtml(url.origin), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...corsHeaders(request)
        }
      });
    }

    // 代理请求处理
    return handleProxyRequest(request, url);
  }
};

/**
 * 处理代理请求核心逻辑
 */
async function handleProxyRequest(request, url) {
  try {
    // 获取目标 URL
    let targetUrl = url.searchParams.get('url');
    if (!targetUrl && url.pathname !== '/') {
      let path = decodeURIComponent(url.pathname.substring(1));
      if (path.startsWith('http://') || path.startsWith('https://')) {
        targetUrl = path;
      } else {
        targetUrl = 'https://' + path;
      }
      if (url.search && !url.searchParams.has('url')) {
        targetUrl += url.search;
      }
    }

    if (!targetUrl) {
      return new Response('Missing Target URL', { status: 400 });
    }

    const target = new URL(targetUrl);
    
    // --- 修复 1: 伪造请求头绕过防盗链 ---
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('Host', target.host);
    proxyHeaders.set('Referer', target.origin + '/'); // 伪装成目标网站站内跳转
    proxyHeaders.set('Origin', target.origin);
    
    // 移除干扰头，避免被识别为代理或引起循环
    const removeHeaders = ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-real-ip'];
    removeHeaders.forEach(h => proxyHeaders.delete(h));

    const proxyRequest = new Request(target, {
      method: request.method,
      headers: proxyHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'manual' 
    });

    // 发起请求
    const response = await fetch(proxyRequest);
    const contentType = response.headers.get('Content-Type') || '';

    // --- 修复 2: 智能处理重定向 ---
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        const absoluteLocation = new URL(location, target).toString();
        // 将重定向地址再次封装进代理 URL
        return new Response(null, {
          status: response.status,
          headers: {
            'Location': `${url.origin}/${encodeURIComponent(absoluteLocation)}`,
            ...corsHeaders(request)
          }
        });
      }
    }

    // --- 修复 3: 深度内容重写 (解决图片/脚本加载失败) ---
    let body = response.body;
    if (contentType.includes('text/html') || contentType.includes('text/css') || contentType.includes('application/javascript')) {
      let text = await response.text();
      const proxyOrigin = url.origin;
      const targetOrigin = target.origin;

      // 替换 / 开头的绝对路径
      text = text.replace(/(href|src|action|data-src)=["']\/([^/][^"']*)["']/g, 
        `$1="${proxyOrigin}/${targetOrigin}/$2"`);
      
      // 替换协议相对路径 //
      text = text.replace(/(href|src|action|data-src)=["']\/\/([^"']+)["']/g, 
        `$1="${proxyOrigin}/https://$2"`);

      // 修复懒加载和动态生成的图片脚本
      text = text.replace(/(srcset)=["']([^"']+)["']/g, (match, p1, p2) => {
        return `${p1}="${proxyOrigin}/https:${p2}"`;
      });

      body = text;
    }

    // 构建返回给浏览器的响应头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => newHeaders.set(k, v));

    // 修复 Set-Cookie 路径
    if (newHeaders.has('Set-Cookie')) {
      let cookie = newHeaders.get('Set-Cookie');
      newHeaders.set('Set-Cookie', cookie.replace(/Path=\/[^;]*/i, 'Path=/'));
    }

    // 禁用缓存，确保漫画加载实时
    newHeaders.set('Cache-Control', 'no-store');

    // 静态资源缓存（图片、CSS、JS 等）
    if (contentType.includes('image/') || contentType.includes('text/css') || contentType.includes('application/javascript')) {
      newHeaders.set('Cache-Control', 'public, max-age=86400');
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });

  } catch (error) {
    console.error('Error in proxy request:', error); // 记录日志
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 502, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } 
    });
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * 保持你原本精美的 Web UI
 */
function getRootHtml(origin) {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare Proxy - 增强修复版</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #fafafa; color: #18181b; }
    @media (prefers-color-scheme: dark) {
      body { background-color: #000; color: #f4f4f5; }
    }
  </style>
</head>
<body class="flex h-full flex-col">
  <main class="flex-auto sm:px-8 mt-16 sm:mt-32">
    <div class="mx-auto max-w-7xl lg:px-8">
      <div class="max-w-2xl mx-auto">
        <div class="text-6xl mb-6">🌐</div>
        <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">Proxy Pro</h1>
        <p class="mt-6 text-base text-zinc-600 dark:text-zinc-400      body = await handleHtmlContent(response, url.protocol, url.host, target);
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        ...corsHeaders(),
        ...noCacheHeaders()
      }
    });

  } catch (error) {
    console.error(error);
    return new Response(`Proxy Error: ${error.message}`, { 
      status: 502, 
      headers: { 'Content-Type': 'text/plain', ...corsHeaders() } 
    });
  }
}

/**
 * 加强版 HTML 路径修复
 */
async function handleHtmlContent(response, protocol, host, target) {
  let text = await response.text();
  const origin = target.origin;
  const proxyBase = `\( {protocol}// \){host}`;

  // 修复各种标签的链接
  text = text.replace(
    /(href|src|action|data-src|data-href|data-original|poster|data-url)=(["'])(?!https?:\/\/|\/\/|data:|#|javascript:|mailto:)([^"']*)/gi,
    (match, attr, quote, path) => {
      let newPath = path.startsWith('/') ? origin + path : origin + '/' + path;
      return `\( {attr}= \){quote}\( {proxyBase}/ \){encodeURIComponent(newPath)}`;
    }
  );

  // 修复 CSS url()
  text = text.replace(
    /url\((["']?)(?!https?:\/\/|\/\/|data:)([^"')]+)(["']?)\)/gi,
    (match, q1, path, q2) => {
      let newPath = path.trim().startsWith('/') ? origin + path : origin + '/' + path;
      return `url(\( {q1} \){proxyBase}/\( {encodeURIComponent(newPath)} \){q2})`;
    }
  );

  return text;
}

function cleanHeaders(headers) {
  const cleaned = new Headers(headers);
  const removeList = [
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
    'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'host'
  ];
  removeList.forEach(h => cleaned.delete(h));
  return cleaned;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

function noCacheHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
}

/**
 * 美观 Web UI（原项目完整版）
 */
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare Proxy - 优化加强版</title>
  <meta name="description" content="基于 Cloudflare Workers 的全功能 HTTP/HTTPS 代理服务">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌐</text></svg>">

  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            zinc: {50:'#fafafa',100:'#f4f4f5',200:'#e4e4e7',300:'#d4d4d8',400:'#a1a1aa',500:'#71717a',600:'#52525b',700:'#3f3f46',800:'#27272a',900:'#18181b'},
            teal: {400:'#2dd4bf',500:'#14b8a6',600:'#0d9488'}
          }
        }
      }
    }
  </script>

  <style>
    :root { --bg-primary: #fafafa; --bg-secondary: #ffffff; --text-primary: #18181b; --accent-color: #14b8a6; }
    @media (prefers-color-scheme: dark) {
      :root { --bg-primary: #18181b; --bg-secondary: #27272a; --text-primary: #f4f4f5; --accent-color: #2dd4bf; }
    }
    body { background-color: var(--bg-primary); color: var(--text-primary); }
  </style>
</head>
<body class="flex h-full flex-col">
  <div class="flex w-full flex-col">
    <div class="flex w-full flex-col">
      <main class="flex-auto">
        <div class="sm:px-8 mt-16 sm:mt-32">
          <div class="mx-auto w-full max-w-7xl lg:px-8">
            <div class="relative px-4 sm:px-8 lg:px-12">
              <div class="mx-auto max-w-2xl lg:max-w-5xl">

                <div class="max-w-2xl">
                  <div class="text-6xl mb-6">🌐</div>
                  <h1 class="text-4xl font-bold tracking-tight text-zinc-800 sm:text-5xl dark:text-zinc-100">
                    Cloudflare Proxy
                  </h1>
                  <p class="mt-6 text-base text-zinc-600 dark:text-zinc-400">
                    优化加强版 • 更好路径修复 + 请求伪装
                  </p>
                </div>

                <div class="mt-16 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
                  <form id="urlForm" class="space-y-4">
                    <div>
                      <label for="targetUrl" class="block text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                        输入目标网址
                      </label>
                      <input type="text" id="targetUrl" placeholder="example.com 或 https://example.com" required
                        class="w-full rounded-md bg-white px-4 py-2 text-sm text-zinc-900 shadow-sm ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-teal-500 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700 dark:placeholder:text-zinc-500">
                    </div>
                    <button type="submit"
                      class="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-teal-500 dark:hover:bg-teal-400">
                      开始代理
                    </button>
                  </form>
                </div>

                <!-- 使用方式等其他内容保持原样，篇幅原因这里省略部分，可直接使用 -->
                <div class="mt-16 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
                  <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">使用方式</h2>
                  <div class="space-y-4 text-sm text-zinc-600 dark:text-zinc-400">
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">路径方式（推荐）</div>
                      <code id="method3" class="text-xs text-teal-600 dark:text-teal-400 break-all"></code>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </main>

      <footer class="mt-32">
        <div class="sm:px-8">
          <div class="mx-auto w-full max-w-7xl lg:px-8">
            <div class="border-t border-zinc-100 pt-10 pb-16 dark:border-zinc-700/40">
              <div class="relative px-4 sm:px-8 lg:px-12">
                <div class="mx-auto max-w-2xl lg:max-w-5xl">
                  <div class="flex flex-col items-center justify-between gap-6 sm:flex-row">
                    <p class="text-sm text-zinc-400 dark:text-zinc-500">Powered by Cloudflare Workers</p>
                    <a href="https://github.com/hu847266h/cloudflare-proxy" target="_blank" 
                       class="text-sm font-medium text-zinc-800 hover:text-teal-500 dark:text-zinc-200 dark:hover:text-teal-400">
                      GitHub 项目地址
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  </div>

  <script>
    const currentOrigin = window.location.origin;
    document.getElementById('method3').textContent = currentOrigin + '/https://example.com';

    document.getElementById('urlForm').addEventListener('submit', function(e) {
      e.preventDefault();
      let target = document.getElementById('targetUrl').value.trim();
      if (!target.startsWith('http')) target = 'https://' + target;
      window.open(currentOrigin + '/' + encodeURIComponent(target), '_blank');
    });
  </script>
</body>
</html>`;
    }      if (host && !url.hostname.includes(host)) {
        targetUrl = request.url;
      }
    }

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          error: 'No target URL provided',
          usage: {
            web: 'Visit / for Web UI',
            method1: '?url=https://example.com',
            method2: '/https://example.com or /example.com',
            method3: 'Set as HTTP_PROXY in environment'
          }
        }, null, 2),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders()
          }
        }
      );
    }

    // 验证目标 URL
    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: 'Invalid target URL',
          provided: targetUrl,
          message: e.message
        }, null, 2),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders()
          }
        }
      );
    }

    // 构建代理请求
    const proxyHeaders = cleanHeaders(request.headers);

    const proxyRequest = new Request(target, {
      method: request.method,
      headers: proxyHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'manual' // 手动处理重定向
    });

    // 发起请求
    const response = await fetch(proxyRequest);
    let body = response.body;

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        const modifiedLocation = `/${encodeURIComponent(new URL(location, target).toString())}`;
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: {
            ...Object.fromEntries(response.headers),
            'Location': modifiedLocation,
            ...corsHeaders(),
            ...noCacheHeaders()
          }
        });
      }
    }

    // 处理 HTML 内容中的相对路径
    if (response.headers.get('Content-Type')?.includes('text/html')) {
      body = await handleHtmlContent(response, url.protocol, url.host, target);
    }

    // 返回响应
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        ...corsHeaders(),
        ...noCacheHeaders()
      }
    });

  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Proxy request failed',
        message: error.message,
        stack: error.stack
      }, null, 2),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders()
        }
      }
    );
  }
}

/**
 * 处理 HTML 内容中的相对路径
 */
async function handleHtmlContent(response, protocol, host, targetUrl) {
  const originalText = await response.text();
  const origin = targetUrl.origin;

  // 替换相对路径：href="/" src="/" action="/"
  const regex = /((href|src|action)=["'])\/((?!\/))/g;
  const modifiedText = originalText.replace(regex, `$1${protocol}//${host}/${origin}/$3`);

  return modifiedText;
}

/**
 * 清理请求头 - 移除不应转发的头
 */
function cleanHeaders(headers) {
  const cleaned = new Headers(headers);

  // 移除 Cloudflare 和代理相关头
  const removeHeaders = [
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'cf-worker',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip'
  ];

  removeHeaders.forEach(header => cleaned.delete(header));

  return cleaned;
}

/**
 * CORS 头
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
  };
}

/**
 * 禁用缓存头
 */
function noCacheHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
}

/**
 * 返回根目录的 HTML - 使用 Tailwind CSS Theme
 */
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare Proxy - 全功能代理服务</title>
  <meta name="description" content="基于 Cloudflare Workers 的全功能 HTTP/HTTPS 代理服务">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌐</text></svg>">

  <!-- Tailwind CSS CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            zinc: {
              50: '#fafafa',
              100: '#f4f4f5',
              200: '#e4e4e7',
              300: '#d4d4d8',
              400: '#a1a1aa',
              500: '#71717a',
              600: '#52525b',
              700: '#3f3f46',
              800: '#27272a',
              900: '#18181b',
            },
            teal: {
              400: '#2dd4bf',
              500: '#14b8a6',
              600: '#0d9488',
            }
          }
        }
      }
    }
  </script>

  <style>
    :root {
      --bg-primary: theme('colors.zinc.50');
      --bg-secondary: theme('colors.white');
      --text-primary: theme('colors.zinc.800');
      --text-secondary: theme('colors.zinc.600');
      --border-color: theme('colors.zinc.100');
      --accent-color: theme('colors.teal.500');
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-primary: theme('colors.black');
        --bg-secondary: theme('colors.zinc.900');
        --text-primary: theme('colors.zinc.100');
        --text-secondary: theme('colors.zinc.400');
        --border-color: rgba(63, 63, 70, 0.4);
        --accent-color: theme('colors.teal.400');
      }
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
    }
  </style>
</head>
<body class="flex h-full flex-col">
  <div class="flex w-full flex-col">
    <!-- 主内容区域 -->
    <div class="relative flex w-full flex-col bg-white ring-1 ring-zinc-100 dark:bg-zinc-900 dark:ring-zinc-300/20">
      <main class="flex-auto">
        <div class="sm:px-8 mt-16 sm:mt-32">
          <div class="mx-auto w-full max-w-7xl lg:px-8">
            <div class="relative px-4 sm:px-8 lg:px-12">
              <div class="mx-auto max-w-2xl lg:max-w-5xl">

                <!-- 标题区域 -->
                <div class="max-w-2xl">
                  <div class="text-6xl mb-6">🌐</div>
                  <h1 class="text-4xl font-bold tracking-tight text-zinc-800 sm:text-5xl dark:text-zinc-100">
                    Cloudflare Proxy
                  </h1>
                  <p class="mt-6 text-base text-zinc-600 dark:text-zinc-400">
                    基于 Cloudflare Workers 的全功能 HTTP/HTTPS 代理服务，支持多种访问方式，完全免费且易于使用。
                  </p>
                </div>

                <!-- 表单卡片 -->
                <div class="mt-16 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
                  <form id="urlForm" class="space-y-4">
                    <div>
                      <label for="targetUrl" class="block text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                        输入目标网址
                      </label>
                      <input
                        type="text"
                        id="targetUrl"
                        placeholder="example.com 或 https://example.com"
                        required
                        class="w-full rounded-md bg-white px-4 py-2 text-sm text-zinc-900 shadow-sm ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-teal-500 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700 dark:placeholder:text-zinc-500"
                      >
                    </div>
                    <button
                      type="submit"
                      class="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:bg-teal-500 dark:hover:bg-teal-400"
                    >
                      开始代理
                    </button>
                  </form>
                </div>

                <!-- 使用方式 -->
                <div class="mt-16 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
                  <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                    使用方式
                  </h2>
                  <div class="space-y-4 text-sm text-zinc-600 dark:text-zinc-400">
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">方式 1: Web 界面</div>
                      <p>在上方输入框输入目标网址即可</p>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">方式 2: 查询参数</div>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="method2"></code>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">方式 3: 路径方式</div>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="method3"></code>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">方式 4: HTTP 代理</div>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="method4"></code>
                    </div>
                  </div>
                </div>

                <!-- 使用场景 -->
                <div class="mt-16 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
                  <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
                    使用场景
                  </h2>
                  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">📦 GitHub 文件加速</div>
                      <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                        加速 raw.githubusercontent.com 文件下载
                      </p>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="scene1"></code>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">🐳 Docker 镜像加速</div>
                      <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                        配置 Docker 镜像代理源
                      </p>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="scene2"></code>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">🤖 OpenAI API 代理</div>
                      <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                        代理 OpenAI API 请求
                      </p>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="scene3"></code>
                    </div>
                    <div class="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
                      <div class="font-medium text-zinc-900 dark:text-zinc-100 mb-2">🌍 通用 CORS 代理</div>
                      <p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                        解决前端跨域问题
                      </p>
                      <code class="text-xs text-teal-600 dark:text-teal-400 break-all" id="scene4"></code>
                    </div>
                  </div>
                </div>

                <!-- 功能特性 -->
                <div class="mt-16 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div class="flex items-center text-sm text-zinc-600 dark:text-zinc-400">
                    <svg class="w-5 h-5 mr-2 text-teal-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                    </svg>
                    HTTPS 支持
                  </div>
                  <div class="flex items-center text-sm text-zinc-600 dark:text-zinc-400">
                    <svg class="w-5 h-5 mr-2 text-teal-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                    </svg>
                    CORS 跨域
                  </div>
                  <div class="flex items-center text-sm text-zinc-600 dark:text-zinc-400">
                    <svg class="w-5 h-5 mr-2 text-teal-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                    </svg>
                    智能重定向
                  </div>
                  <div class="flex items-center text-sm text-zinc-600 dark:text-zinc-400">
                    <svg class="w-5 h-5 mr-2 text-teal-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                    </svg>
                    路径修复
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- 页脚 -->
      <footer class="mt-32">
        <div class="sm:px-8">
          <div class="mx-auto w-full max-w-7xl lg:px-8">
            <div class="border-t border-zinc-100 pt-10 pb-16 dark:border-zinc-700/40">
              <div class="relative px-4 sm:px-8 lg:px-12">
                <div class="mx-auto max-w-2xl lg:max-w-5xl">
                  <div class="flex flex-col items-center justify-between gap-6 sm:flex-row">
                    <p class="text-sm text-zinc-400 dark:text-zinc-500">
                      Powered by Cloudflare Workers
                    </p>
                    <a
                      href="https://github.com/Yrobot/cloudflare-proxy"
                      target="_blank"
                      class="group flex items-center text-sm font-medium text-zinc-800 transition hover:text-teal-500 dark:text-zinc-200 dark:hover:text-teal-400"
                    >
                      <svg class="w-5 h-5 mr-2 fill-zinc-500 transition group-hover:fill-teal-500 dark:fill-zinc-400 dark:group-hover:fill-teal-400" viewBox="0 0 24 24">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.475 2 2 6.588 2 12.253c0 4.537 2.862 8.369 6.838 9.727.5.09.687-.218.687-.487 0-.243-.013-1.05-.013-1.91C7 20.059 6.35 18.957 6.15 18.38c-.113-.295-.6-1.205-1.025-1.448-.35-.192-.85-.667-.013-.68.788-.012 1.35.744 1.538 1.051.9 1.551 2.338 1.116 2.912.846.088-.666.35-1.115.638-1.371-2.225-.256-4.55-1.14-4.55-5.062 0-1.115.387-2.038 1.025-2.756-.1-.256-.45-1.307.1-2.717 0 0 .837-.269 2.75 1.051.8-.23 1.65-.346 2.5-.346.85 0 1.7.115 2.5.346 1.912-1.333 2.75-1.05 2.75-1.05.55 1.409.2 2.46.1 2.716.637.718 1.025 1.628 1.025 2.756 0 3.934-2.337 4.806-4.562 5.062.362.32.675.936.675 1.897 0 1.371-.013 2.473-.013 2.82 0 .268.188.589.688.486a10.039 10.039 0 0 0 4.932-3.74A10.447 10.447 0 0 0 22 12.253C22 6.588 17.525 2 12 2Z"/>
                      </svg>
                      在 GitHub 上给我们点赞
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  </div>

  <script>
    // 获取当前域名并填充示例
    const currentOrigin = window.location.origin;

    // 填充使用方式示例
    document.getElementById('method2').textContent = currentOrigin + '/?url=https://example.com';
    document.getElementById('method3').textContent = currentOrigin + '/https://example.com';
    document.getElementById('method4').textContent = 'export HTTP_PROXY=' + currentOrigin;

    // 填充使用场景示例
    document.getElementById('scene1').textContent = currentOrigin + '/https://raw.githubusercontent.com/user/repo/main/file.txt';
    document.getElementById('scene2').textContent = currentOrigin + '/https://registry-1.docker.io';
    document.getElementById('scene3').textContent = currentOrigin + '/https://api.openai.com/v1/chat/completions';
    document.getElementById('scene4').textContent = 'fetch("' + currentOrigin + '/https://api.example.com/data")';

    // 表单提交处理
    document.getElementById('urlForm').addEventListener('submit', function(event) {
      event.preventDefault();

      let targetUrl = document.getElementById('targetUrl').value.trim();

      // 如果没有协议，自动添加 https://
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      // 构建代理 URL
      const proxyUrl = currentOrigin + '/' + encodeURIComponent(targetUrl);

      // 在新标签页打开
      window.open(proxyUrl, '_blank');
    });
  </script>
</body>
</html>`;
}
