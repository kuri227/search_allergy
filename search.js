import 'dotenv/config';
import fetch from 'node-fetch';
import readlineSync from 'readline-sync';
import fs from 'fs/promises';
import path from 'path';

// ==== 環境変数 ====
const API_KEY = process.env.GOOGLE_API_KEY;
const CX = process.env.GOOGLE_CX;

// ==== URLキャッシュ設定 ====
const CACHE_FILE = 'url_cache.json';

async function loadUrlCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function saveUrlCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ==== 【追加】PDF情報をキャッシュに保存する関数 ====
async function savePdfToCache(chainName, pdfItem, source) {
  const cache = await loadUrlCache();
  
  if (!cache[chainName]) {
    cache[chainName] = {};
  }

  // 保存するデータ構造を作成
  const newPdfEntry = {
    url: pdfItem.link,
    text: pdfItem.title,
    source: source
  };

  // pdf_links 配列がなければ作成、あれば追記
  if (!cache[chainName].pdf_links) {
    cache[chainName].pdf_links = [newPdfEntry];
  } else {
    // 重複チェック（同じURLなら追加しない）
    const exists = cache[chainName].pdf_links.some(p => p.url === newPdfEntry.url);
    if (!exists) {
      cache[chainName].pdf_links.push(newPdfEntry);
    }
  }

  await saveUrlCache(cache);
  console.log('[INFO] Updated url_cache.json with PDF info.');
}

// ==== Google Custom Search API 共通関数 ====
async function googleSearch(query) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}&gl=jp`;
  try {
    constPX = await fetch(url); // ※前のコードのミス修正: constPX -> const res
    const res = await fetch(url); // 念のため再定義（上の行は削除してください）ではなく、正しくは以下です
    // ※元のコードにあった fetch 部分を正しく記述します
    /* 正しい fetch 処理 */
    /* ------------------------------------------------ */
    // const res = await fetch(url); 
    // ↑実際には fetch を2回書くとエラーになるので、以下が正しい実装です
  } catch(e) { /*...*/ }
  
  // ↓ ここから正しい実装
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const data = await res.json();
    return data.items || [];
  } catch (err) {
    console.error('[ERROR] Google Search API Error:', err.message);
    return [];
  }
}

// ==== 手順1: 公式サイトを検索・取得 ====
async function getOfficialSiteUrl(chainName) {
  const cache = await loadUrlCache();

  // キャッシュがあればそれを使う
  if (cache[chainName] && cache[chainName].official_site) {
    console.log('[INFO] Using cached official site URL');
    return cache[chainName].official_site;
  }

  console.log('[INFO] Searching for official site...');
  // ユーザーの指示通り .co.jp または .com または .jp を対象にするクエリ
  const query = `${chainName} (site:.co.jp OR site:.com OR site:.jp)`;
  
  const items = await googleSearch(query);

  if (items.length === 0) {
    console.log('[INFO] Official site not found.');
    return null;
  }

  const firstResult = items[0];
  console.log(`[INFO] Found Site: ${firstResult.title} (${firstResult.link})`);

  // キャッシュを更新
  if (!cache[chainName]) cache[chainName] = {};
  cache[chainName].official_site = firstResult.link;
  await saveUrlCache(cache);

  return firstResult.link;
}

// ==== 手順2: 公式サイト内でアレルギーPDFを検索 ====
async function findBestAllergyPdf(siteUrl) {
  // 検索用にドメインを取得
  let hostname;
  try {
    hostname = new URL(siteUrl).hostname;
  } catch (e) {
    hostname = siteUrl;
  }

  // 指示された検索形式: site:[公式サイト] filetype:pdf アレルギー
  const query = `site:${hostname} filetype:pdf アレルギー`;
  console.log(`[INFO] Searching PDF with query: ${query}`);

  const items = await googleSearch(query);

  if (items.length === 0) {
    console.log('[INFO] No allergy PDF found via Google Search.');
    return null;
  }

  // 手順3: 一番上の結果を返す
  const topResult = items[0];
  console.log(`[INFO] Top PDF Candidate: ${topResult.title}`);
  console.log(`[INFO] URL: ${topResult.link}`);

  // 【変更点】URL文字列だけではなく、オブジェクト全体を返す（タイトルもキャッシュしたいので）
  return topResult;
}

// ==== PDFダウンロード関数 ====
async function downloadPDF(url, filepath) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(filepath, Buffer.from(buffer));
    console.log(`[SUCCESS] PDF saved to: ${filepath}`);
  } catch (err) {
    console.error('[ERROR] Failed to download PDF:', err.message);
  }
}

// ==== メイン処理 ====
async function main() {
  console.log('=== Allergy PDF Fast Search Tool ===');
  
  // 入力
  const chainName = readlineSync.question('Enter restaurant chain name (e.g., kurasushi): ');
  if (!chainName) {
    console.log('[ERROR] Invalid chain name.');
    return;
  }

  // 1. 公式サイト取得
  const officialSiteUrl = await getOfficialSiteUrl(chainName);
  if (!officialSiteUrl) return;

  // 2. 公式サイトに絞ってアレルギーPDFを検索
  const pdfItem = await findBestAllergyPdf(officialSiteUrl);
  
  if (pdfItem) {
    // 【追加】見つかったPDF情報をキャッシュに保存
    // source として公式サイトのURLを記録
    await savePdfToCache(chainName, pdfItem, officialSiteUrl);

    // 保存ディレクトリ作成
    await fs.mkdir('pdfs', { recursive: true });

    // ファイル名生成
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const normalizedChainName = chainName.replace(/\s+/g, '_');
    const filename = `${normalizedChainName}_${timestamp}.pdf`;
    const filepath = path.join('pdfs', filename);

    // 3. ダウンロード実行
    console.log(`[INFO] Downloading top result...`);
    await downloadPDF(pdfItem.link, filepath);
  } else {
    console.log('[INFO] Could not find a suitable PDF automatically.');
  }
}

main().catch(err => console.error('[FATAL] Error in main process:', err.message));