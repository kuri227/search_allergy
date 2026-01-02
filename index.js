import 'dotenv/config';
import fetch from 'node-fetch';
import readlineSync from 'readline-sync';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import fs from 'fs/promises';
import path from 'path';
import xml2js from 'xml2js';
import puppeteer from 'puppeteer';

// ==== ここを自分のキー・IDに置き換える ====
const API_KEY = process.env.GOOGLE_API_KEY;
const CX = process.env.GOOGLE_CX;

// ==== Search for official site using Google Custom Search API ====
async function findOfficialSite(chainName) {
  const query = `${chainName} official site`;
  const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTPエラー: ${res.status}`);
    const data = await res.json();

    if (!data.items || data.items.length === 0) {
      console.log('[INFO] No search results found.');
      return null;
    }

    // First search result
    const firstResult = data.items[0];
    console.log(`[INFO] Title: ${firstResult.title}`);
    console.log(`[INFO] Snippet: ${firstResult.snippet}`);
    console.log(`[INFO] Official site candidate: ${firstResult.link}`);

    return firstResult.link;
  } catch (err) {
    console.error('[ERROR] Error during search:', err.message);
    return null;
  }
}

// Function to fetch and parse robots.txt
async function getRobotsRules(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const response = await fetch(robotsUrl);
    const robotsTxt = await response.text();
    return robotsParser(robotsUrl, robotsTxt);
  } catch (err) {
    console.log('[INFO] Failed to fetch robots.txt. Applying default rules.');
    return null;
  }
}

// Check if URL is allowed to be crawled
function isAllowedByRobots(robots, url) {
  if (!robots) return true;
  return robots.isAllowed(url, 'CustomBot');
}

// Function to extract PDF links from page
async function searchPDFsInPage(url, robots) {
  if (robots && !isAllowedByRobots(robots, url)) {
    console.log(`[INFO] Skipped by robots.txt: ${url}`);
    return [];
  }

  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);
    const pagePdfLinks = [];

    $('a').each((_, element) => {
      const href = $(element).attr('href');
      const linkText = $(element).text().trim();
      if (!href) return;

      try {
        const fullUrl = new URL(href, url).href;
        const isPDF = fullUrl.toLowerCase().endsWith('.pdf');
        
        // キーワードをURLまたはリンクテキストで判定
        const ALLERGY_KEYWORDS = [
          'allergy', 'アレルギー', 'allergen', 'pictogram',
          '特定原材料', '原料', '成分', '含まれる', 'allergen',
          'ingredient', 'ingredients'
        ];
        const isAllergyKeyword = ALLERGY_KEYWORDS.some(keyword =>
          new RegExp(keyword, 'i').test(fullUrl) || 
          new RegExp(keyword, 'i').test(linkText)
        );

        // PDFファイルでキーワードマッチ、またはリンクテキストがアレルギー関連
        if (isPDF && isAllergyKeyword) {
          if (robots && isAllowedByRobots(robots, fullUrl)) {
            pagePdfLinks.push({
              url: fullUrl,
              text: linkText || 'PDF',
              source: url
            });
          }
        }
      } catch (e) {
        // 無効なURLは無視
      }
    });

    return pagePdfLinks;
  } catch (err) {
    console.error(`[ERROR] Error searching page (${url}):`, err.message);
    return [];
  }
}

// PDF search function with JavaScript rendering support
async function searchPDFsInPageWithJS(url, robots) {
  if (robots && !isAllowedByRobots(robots, url)) {
    console.log(`[INFO] Skipped by robots.txt: ${url}`);
    return [];
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    
    // ページを読み込む
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // ページ内のすべてのリンクを抽出（JavaScriptレンダリング後）
    const links = await page.evaluate(() => {
      const allLinks = [];
      
      // <a>タグから抽出
      document.querySelectorAll('a').forEach(el => {
        const href = el.getAttribute('href');
        if (href) allLinks.push({ href, text: el.textContent.trim() });
      });
      
      // <button>やその他要素のデータ属性から抽出
      document.querySelectorAll('button, div[data-url], div[data-href]').forEach(el => {
        const href = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('onclick');
        if (href) allLinks.push({ href, text: el.textContent.trim() });
      });
      
      return allLinks;
    });

    const pagePdfLinks = [];
    const ALLERGY_KEYWORDS = [
      'allergy', 'アレルギー', 'allergen', 'pictogram',
      '特定原材料', '原料', '成分', '含まれる',
      'ingredient', 'ingredients'
    ];

    for (const link of links) {
      try {
        const fullUrl = new URL(link.href, url).href;
        const isPDF = fullUrl.toLowerCase().endsWith('.pdf');
        
        const isAllergyKeyword = ALLERGY_KEYWORDS.some(keyword =>
          new RegExp(keyword, 'i').test(fullUrl) || 
          new RegExp(keyword, 'i').test(link.text)
        );

        if (isPDF && isAllergyKeyword) {
          if (robots && isAllowedByRobots(robots, fullUrl)) {
            pagePdfLinks.push({
              url: fullUrl,
              text: link.text || 'PDF',
              source: url
            });
          }
        }
      } catch (e) {
        // 無効なURLは無視
      }
    }

    await browser.close();
    return pagePdfLinks;
  } catch (err) {
    console.error(`[ERROR] JavaScript rendering error (${url}):`, err.message);
    if (browser) await browser.close();
    // Fallback: retry with normal method
    return await searchPDFsInPage(url, robots);
  }
}

// Function to get sub-page URLs
async function getSubpageUrls(baseUrl, robots) {
  if (robots && !isAllowedByRobots(robots, baseUrl)) {
    return [];
  }

  try {
    const response = await fetch(baseUrl);
    const html = await response.text();
    const $ = cheerio.load(html);
    const subpageUrls = new Set();

    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      try {
        const fullUrl = new URL(href, baseUrl).href;
        if (fullUrl.startsWith(baseUrl)) {
          subpageUrls.add(fullUrl);
        }
      } catch (e) {
        // 無効なURLは無視
      }
    });

    return Array.from(subpageUrls);
  } catch (err) {
    console.error('[ERROR] Error fetching sub-pages:', err.message);
    return [];
  }
}

// Function to fetch and parse sitemap.xml
async function getSitemapUrls(baseUrl) {
  try {
    const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
    console.log(`[INFO] Fetching sitemap: ${sitemapUrl}`);
    const response = await fetch(sitemapUrl);
    if (!response.ok) {
      console.log('[INFO] Sitemap not found');
      return [];
    }
    
    const xml = await response.text();
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);
    
    if (result.urlset && result.urlset.url) {
      const urls = result.urlset.url.map(item => item.loc[0]);
      console.log(`[INFO] Retrieved ${urls.length} URLs from sitemap`);
      return urls;
    }
    return [];
  } catch (err) {
    console.log('[INFO] Failed to parse sitemap:', err.message);
    return [];
  }
}

// Function for parallel sub-page search (with load control)
async function searchSubpagesParallel(subpageUrls, robots, maxConcurrent = 2) {
  const pdfLinks = [];
  const delayMs = 2000; // 2 second delay between batches
  
  for (let i = 0; i < subpageUrls.length; i += maxConcurrent) {
    const batch = subpageUrls.slice(i, i + maxConcurrent);
    console.log(`[INFO] Batch processing (${i + 1}~${Math.min(i + maxConcurrent, subpageUrls.length)}/${subpageUrls.length})`);
    
    const results = await Promise.all(
      batch.map(async (url, idx) => {
        // Interval within batches
        await new Promise(resolve => 
          setTimeout(resolve, idx * (delayMs / maxConcurrent))
        );
        console.log(`[INFO] Searching sub-page: ${url}`);
        return await searchPDFsInPage(url, robots);
      })
    );
    pdfLinks.push(...results.flat());
    
    // バッチ間にも2秒の遅延
    if (i + maxConcurrent < subpageUrls.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return pdfLinks;
}

// Function to search all sitemap URLs for PDFs
async function searchSitemapUrlsForPdfs(sitemapUrls, robots) {
  const pdfLinks = [];
  
  for (const sitemapUrl of sitemapUrls) {
    console.log(`[INFO] Checking sitemap URL: ${sitemapUrl}`);
    // allergenページなどの動的コンテンツが疑わしい場合はJSレンダリングを使用
    const pdfs = sitemapUrl.includes('allergen') || sitemapUrl.includes('origin')
      ? await searchPDFsInPageWithJS(sitemapUrl, robots)
      : await searchPDFsInPage(sitemapUrl, robots);
    pdfLinks.push(...pdfs);
    
    // レート制限
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return pdfLinks;
}

// Main PDF search function
async function findAllergyPDFs(siteUrl) {
  const pdfLinks = [];
  const visitedUrls = new Set();
  
  try {
    console.log('[INFO] Checking robots.txt...');
    const robots = await getRobotsRules(siteUrl);

    console.log('[INFO] Searching main page...');
    const mainPagePdfs = await searchPDFsInPage(siteUrl, robots);
    pdfLinks.push(...mainPagePdfs);
    visitedUrls.add(siteUrl);

    // Get URLs from sitemap with priority
    console.log('[INFO] Checking sitemap...');
    const sitemapUrls = await getSitemapUrls(siteUrl);
    
    if (sitemapUrls.length > 0) {
      console.log(`[INFO] Retrieved ${sitemapUrls.length} URLs from sitemap`);
      const unvisitedSitemapUrls = sitemapUrls.filter(url => !visitedUrls.has(url));
      unvisitedSitemapUrls.forEach(url => visitedUrls.add(url));
      
      if (unvisitedSitemapUrls.length > 0) {
        console.log('[INFO] Searching sitemap URLs...');
        const sitemapPdfs = await searchSitemapUrlsForPdfs(unvisitedSitemapUrls, robots);
        pdfLinks.push(...sitemapPdfs);
      }
    }

    // Get sub-pages (additional pages not in sitemap)
    console.log('[INFO] Exploring sub-pages...');
    const subpageUrls = await getSubpageUrls(siteUrl, robots);
    console.log(`[INFO] Detected ${subpageUrls.length} sub-pages`);

    // Filter unvisited sub-pages
    const unvisitedUrls = subpageUrls.filter(url => !visitedUrls.has(url));
    unvisitedUrls.forEach(url => visitedUrls.add(url));

    // Search sub-pages in parallel
    if (unvisitedUrls.length > 0) {
      console.log('[INFO] Processing sub-pages in parallel...');
      const subpagePdfs = await searchSubpagesParallel(unvisitedUrls, robots, 2);
      pdfLinks.push(...subpagePdfs);
    }

    return pdfLinks;
  } catch (err) {
    console.error('[ERROR] Error during PDF search:', err.message);
    return pdfLinks;
  }
}

// URLキャッシュの保存と読み込み
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

// Function to normalize URL
function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    // Return protocol + hostname only
    return `${urlObj.protocol}//${urlObj.hostname}`;
  } catch (err) {
    console.error('[ERROR] Invalid URL:', url);
    return url;
  }
}

// Update getOfficialSiteUrl function
async function getOfficialSiteUrl(chainName) {
  const cache = await loadUrlCache();
  
  if (cache[chainName]) {
    console.log('[INFO] Using cached URL');
    return cache[chainName];
  }

  const url = await findOfficialSite(chainName);
  if (url) {
    cache[chainName] = url;
    await saveUrlCache(cache);
  }
  return url;
}

// Update getRobotsRules function to support caching
const robotsCache = new Map();

async function getRobotsRulesWithCache(baseUrl) {
  if (robotsCache.has(baseUrl)) {
    return robotsCache.get(baseUrl);
  }
  
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const response = await fetch(robotsUrl);
    const robotsTxt = await response.text();
    const rules = robotsParser(robotsUrl, robotsTxt);
    robotsCache.set(baseUrl, rules);
    return rules;
  } catch (err) {
    console.log('[INFO] Failed to fetch robots.txt. Applying default rules.');
    return null;
  }
}

// Add PDF download function
async function downloadPDF(url, filepath) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(filepath, Buffer.from(buffer));
    console.log(`[INFO] PDF saved: ${filepath}`);
  } catch (err) {
    console.error('[ERROR] Failed to download PDF:', err.message);
  }
}

// Main process
async function main() {
  console.log('[INFO] Allergy-related PDF Batch Download Tool');
  
  // Get chain name interactively
  const chainName = readlineSync.question('Enter restaurant chain name (in English): ');
  
  // Input validation
  if (!chainName) {
    console.log('[ERROR] Invalid chain name.');
    return;
  }

  // Get official site
  console.log('[INFO] Fetching official site...');
  const officialSiteUrl = await getOfficialSiteUrl(chainName);
  
  if (!officialSiteUrl) {
    console.log('[ERROR] Failed to fetch official site.');
    return;
  }

  console.log(`[INFO] Official site: ${officialSiteUrl}`);

  // Search for PDFs
  console.log('[INFO] Searching for PDFs...');
  const pdfLinks = await findAllergyPDFs(officialSiteUrl);
  
  if (pdfLinks.length === 0) {
    console.log('[INFO] No PDFs found.');
  } else {
    console.log(`[INFO] Found ${pdfLinks.length} PDF links.`);
    pdfLinks.forEach((pdf, idx) => {
      console.log(`${idx + 1}: ${pdf.url} (Source: ${pdf.source})`);
    });

    // Ask user to select PDF numbers
    const input = readlineSync.question('Enter PDF numbers to download (e.g., 1,3,5 or leave empty to skip): ');
    if (input.trim()) {
      const selectedIndices = input.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < pdfLinks.length);
      if (selectedIndices.length === 0) {
        console.log('[INFO] No valid numbers were selected.');
        return;
      }

      // Create pdfs folder if it doesn't exist
      await fs.mkdir('pdfs', { recursive: true });

      // Generate timestamp (YYYY-MM-DDTHH-MM-SS format)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const normalizedChainName = chainName.replace(/\s+/g, '_');

      // Download selected PDFs
      for (const idx of selectedIndices) {
        const pdf = pdfLinks[idx];
        const filename = `${normalizedChainName}_${timestamp}.pdf`;
        const filepath = path.join('pdfs', filename);
        console.log(`[INFO] Downloading: ${pdf.url}`);
        await downloadPDF(pdf.url, filepath);
      }
    } else {
      console.log('[INFO] Download skipped.');
    }
  }
}

// Entry point
main().catch(err => console.error('[ERROR] Error in main process:', err.message));
