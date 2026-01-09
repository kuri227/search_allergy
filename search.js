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

// ==== Google Custom Search API 共通関数 ====
async function googleSearch(query) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}&gl=jp`;
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
  // ユーザーの指示通り .co.jp または .com を対象にするクエリ
  // 例: "くら寿司 site:.co.jp OR site:.com"
  const query = `${chainName} (site:.co.jp OR site:.com)`;
  
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
  // 検索用にドメインを取得 (例: https://www.kurasushi.co.jp/ -> www.kurasushi.co.jp)
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

  return topResult.link;
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
  const pdfUrl = await findBestAllergyPdf(officialSiteUrl);
  
  if (pdfUrl) {
    // 保存ディレクトリ作成
    await fs.mkdir('pdfs', { recursive: true });

    // ファイル名生成 (例: kurasushi_2024-01-01T12-00-00.pdf)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const normalizedChainName = chainName.replace(/\s+/g, '_');
    const filename = `${normalizedChainName}_${timestamp}.pdf`;
    const filepath = path.join('pdfs', filename);

    // 3. ダウンロード実行 (確認なし)
    console.log(`[INFO] Downloading top result...`);
    await downloadPDF(pdfUrl, filepath);
  } else {
    console.log('[INFO] Could not find a suitable PDF automatically.');
  }
}

main().catch(err => console.error('[FATAL] Error in main process:', err.message));