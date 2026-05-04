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
    proxyHeaders.set('X-Requested-With', 'XMLHttpRequest'); // 增强伪装
    proxyHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0'); // 强制设置一个常见的 User-Agent
    
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

      // 处理所有的图片，确保 data-src 和懒加载图像也被代理
      text = text.replace(/(data-src)=["']([^"']+)["']/g, (match, p1, p2) => {
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
        <!-- 这里添加自定义欢迎语句 -->
        <p class="mt-6 text-xl text-teal-500 font-semibold">
          欢迎使用 Cloudflare 代理服务
        </p>
        <p class="mt-6 text-base text-zinc-600 dark:text-zinc-400">
          已针对漫画网站、图片防盗链进行专项修复。支持全协议代理及内容重写。
        </p>

        <div class="mt-10 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
          <form id="urlForm" class="space-y-4">
            <input type="text" id="targetUrl" placeholder="输入漫画站地址 (例如: example.com)" required
              class="w-full rounded-md px-4 py-2 text-sm shadow-sm ring-1 ring-zinc-300 dark:bg-zinc-800 dark:ring-zinc-700">
            <button type="submit" class="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-teal-500">
              开始代理访问
            </button>
          </form>
        </div>

        <div class="mt-10 text-xs text-zinc            'Location': `${url.origin}/${encodeURIComponent(absoluteLocation)}`,
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

      // 处理所有的图片，确保 data-src 和懒加载图像也被代理
      text = text.replace(/(data-src)=["']([^"']+)["']/g, (match, p1, p2) => {
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
        <!-- 这里添加自定义欢迎语句 -->
        <p class="mt-6 text-xl text-teal-500 font-semibold">
          欢迎使用 Cloudflare 代理服务
        </p>
        <p class="mt-6 text-base text-zinc-600 dark:text-zinc-400">
          已针对漫画网站、图片防盗链进行专项修复。支持全协议代理及内容重写。
        </p>

        <div class="mt-10 rounded-2xl border border-zinc-100 p-6 dark:border-zinc-700/40">
          <form id="urlForm" class="space-y-4">
            <input type="text" id="targetUrl" placeholder="输入漫画站地址 (例如: example.com)" required
              class="w-full rounded-md px-4 py-2 text-sm shadow-sm ring-1 ring-zinc-300 dark:bg-zinc-800 dark:ring-zinc-700">
            <button type="submit" class="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-teal-500">
              开始代理访问
            </button>
          </form>
        </div>

        <div class="mt-10 text-xs text-zinc-500">
          直接访问: <code class="text-teal-500">${origin}/https://目标地址</code>
        </div>
      </div>
    </div>
  </main>

  <script>
    document
