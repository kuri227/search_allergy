import fs from 'fs/promises';

async function fixUrlCache() {
  try {
    const cache = JSON.parse(await fs.readFile('url_cache.json', 'utf8'));
    
    // 全URLを正規化
    const fixedCache = Object.fromEntries(
      Object.entries(cache).map(([key, url]) => {
        try {
          const urlObj = new URL(url);
          return [key, `${urlObj.protocol}//${urlObj.hostname}`];
        } catch (err) {
          console.error(`[ERROR] Invalid URL for ${key}:`, url);
          return [key, url];
        }
      })
    );
    
    // 修正したキャッシュを保存
    await fs.writeFile('url_cache.json', JSON.stringify(fixedCache, null, 2));
    console.log('[SUCCESS] URL cache has been normalized');
  } catch (err) {
    console.error('[ERROR] Failed to fix cache:', err);
  }
}

fixUrlCache();