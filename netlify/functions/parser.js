// parser.js
// 解析 MoneyDJ「持股狀況」頁面的 HTML，抽出持股明細表格。
// 與前端 HTML 版本的 parseHoldingsTable 邏輯相同，這裡是給 Netlify Function（Node環境）用的版本。

/**
 * 從 MoneyDJ basic0007 頁面的原始 HTML 中，抽出「持股明細」表格的資料列。
 * MoneyDJ 的表格格式（轉成文字後）大致是：
 *   台積電(2330.TW) 9.97 11,960,000.00
 * 即「名稱(代號.TW) 權重 股數」。
 *
 * 因為這裡拿到的是原始 HTML（不是像 web_fetch 那樣已轉換好的 Markdown），
 * 所以先用正則抓出 <table> 區塊，再從表格列裡解析。
 */
function parseMoneyDJHoldingsHTML(html) {
  const rows = [];

  // 找到「持股明細」標題之後的第一個 table
  const sectionIdx = html.indexOf('持股明細');
  if (sectionIdx === -1) {
    return { rows: [], snapshotDate: null, error: 'NO_HOLDINGS_SECTION' };
  }
  const afterSection = html.slice(sectionIdx);

  // 嘗試抓快照日期，格式如「資料日期：2026/06/18」
  const dateMatch = afterSection.match(/資料日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
  const snapshotDate = dateMatch ? dateMatch[1].replace(/\//g, '-') : null;

  // 找出表格內容：MoneyDJ 用 <table> 包著，逐個 <tr> 解析
  const tableMatch = afterSection.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    return { rows: [], snapshotDate, error: 'NO_TABLE_FOUND' };
  }
  const tableHtml = tableMatch[1];
  const trMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

  trMatches.forEach(tr => {
    // 拿掉所有 HTML 標籤，保留純文字，欄位之間用 | 分隔方便切割
    const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(td =>
      td.replace(/<[^>]+>/g, '').trim()
    );
    if (cells.length < 2) return; // 表頭或不完整列，跳過

    // 第一格通常是「名稱(代號.TW)」
    const nameCell = cells[0];
    const codeMatch = nameCell.match(/^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9\-\*]*)\s*\((\d{4})(?:\.TW)?\)/);
    if (!codeMatch) return;

    const name = codeMatch[1].trim();
    const code = codeMatch[2];
    const weight = parseFloat(cells[1]);
    if (isNaN(weight) || weight <= 0 || weight > 100) return;

    const shares = cells[2] ? parseInt(cells[2].replace(/,/g, '').replace(/\.\d+$/, '')) : undefined;

    rows.push({ code, name, weight, shares });
  });

  return { rows, snapshotDate, error: rows.length === 0 ? 'PARSE_EMPTY' : null };
}

/**
 * 驗證抓回來的頁面，確實是我們要的那檔 ETF，而不是快取/路由錯置到別檔。
 * 用頁面 <title> 或 canonical 裡的代號跟我們請求的代號比對。
 */
function verifyCorrectETF(html, expectedCode) {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const canonicalMatch = html.match(/canonical["']?\s*[:=]\s*["']?([^"'\s]+)/i);
  const codeUpper = expectedCode.toUpperCase();

  const titleHasCode = titleMatch && titleMatch[1].toUpperCase().includes(codeUpper);
  const canonicalHasCode = canonicalMatch && canonicalMatch[1].toUpperCase().includes(codeUpper);

  return {
    verified: !!(titleHasCode || canonicalHasCode),
    titleFound: titleMatch ? titleMatch[1] : null,
  };
}

module.exports = { parseMoneyDJHoldingsHTML, verifyCorrectETF };

/**
 * 解析群益投信官網（capitalfund.com.tw）「投資組合」頁的股票持股表格。
 *
 * 重要說明：群益官網這個頁面用的不是傳統 <table><tr><td> 結構，
 * 而是用一連串重複的區塊呈現「股票代號／股票名稱／持股權重(%)／股數」，
 * 且同一批資料會出現兩次（一次是給排序用的隱藏資料、一次是畫面顯示用的，
 * 從 web_fetch 轉成 Markdown 後可以看到資料重複了兩輪）。
 *
 * 抓取策略：用正則找出「4位數代號」後面跟著「中文/英文名稱」再跟著「數字%」
 * 再跟著「數字,數字（股數）」這個連續四元組的 pattern，逐筆取出，並用代號去重
 * （因為同一筆資料在頁面上會重複出現，只取第一次）。
 *
 * ⚠️ 此函式是依照 2026/06 某次實際抓取結果回推寫成，並非取得官方API文件，
 * 若群益官網改版，這裡的正則需要重新調整。
 */
function parseCapitalfundHoldingsHTML(html) {
  const rows = [];

  // 定位「股票」這個區段標題之後的內容（群益頁面的股票持股區塊由此開始）
  const sectionIdx = html.indexOf('股票代號');
  if (sectionIdx === -1) {
    return { rows: [], snapshotDate: null, error: 'NO_HOLDINGS_SECTION' };
  }
  const afterSection = html.slice(sectionIdx);

  // 快照日期：群益頁面通常顯示在「最新預估淨值」區塊旁的日期，格式如 2026/06/18
  const dateMatch = html.match(/(\d{4}\/\d{2}\/\d{2})/);
  const snapshotDate = dateMatch ? dateMatch[1].replace(/\//g, '-') : null;

  // 拿掉所有 HTML 標籤，轉成純文字後逐行處理，比直接對 HTML 結構做正則更穩定
  // （因為群益頁面的 HTML 結構複雜，純文字反而比較好抓重複出現的資料列）
  const plainText = afterSection
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  // 逐行掃描：找到4位數代號 → 接下來1~2行是名稱 → 接下來找到「N%」格式的權重 → 再找股數
  for (let i = 0; i < plainText.length; i++) {
    const codeLine = plainText[i];
    if (!/^\d{4}$/.test(codeLine)) continue; // 必須整行就是4位數代號，避免誤判其他數字

    const code = codeLine;
    // 名稱通常在代號的下一行
    const nameLine = plainText[i + 1];
    if (!nameLine || !/[\u4e00-\u9fa5A-Za-z]/.test(nameLine)) continue;

    // 往後找最近的「數字%」當作權重（容許跨幾行，因頁面可能重複列出名稱）
    let weight, weightLineIdx;
    for (let j = i + 1; j < Math.min(i + 6, plainText.length); j++) {
      const m = plainText[j].match(/^(\d+\.?\d*)%$/);
      if (m) { weight = parseFloat(m[1]); weightLineIdx = j; break; }
    }
    if (weight === undefined || isNaN(weight) || weight <= 0 || weight > 100) continue;

    // 股數：權重那行之後，找最近的純數字（含千分位逗號）
    let shares;
    for (let k = weightLineIdx + 1; k < Math.min(weightLineIdx + 3, plainText.length); k++) {
      const m = plainText[k].match(/^([\d,]{4,})$/);
      if (m) { shares = parseInt(m[1].replace(/,/g, '')); break; }
    }

    rows.push({ code, name: nameLine.trim(), weight, shares });
  }

  // 去重：群益頁面資料會重複出現兩輪，只保留第一次出現的
  const seen = new Set();
  const dedup = rows.filter(r => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });

  return { rows: dedup, snapshotDate, error: dedup.length === 0 ? 'PARSE_EMPTY' : null };
}

/**
 * 解析台新投信官網（tsit.com.tw）「ETFSeriesDetail」頁的股票持股表格。
 *
 * 已知格式（依先前實際 web_fetch 驗證過的真實內容）：
 *   代號 名稱 股數 持股權重
 *   2383 TT 台光電 41,000 7.0163%
 * 即「代號 + 交易所代碼TT + 中文名 + 股數 + 權重%」，股數在權重之前。
 *
 * 跟群益頁面類似，這裡也是先轉純文字再逐行解析，避免依賴特定HTML結構。
 */
function parseTaishinHoldingsHTML(html) {
  const rows = [];

  const sectionIdx = html.indexOf('股票');
  if (sectionIdx === -1) {
    return { rows: [], snapshotDate: null, error: 'NO_HOLDINGS_SECTION' };
  }
  const afterSection = html.slice(sectionIdx);

  const dateMatch = html.match(/(\d{4}\/\d{2}\/\d{2})/);
  const snapshotDate = dateMatch ? dateMatch[1].replace(/\//g, '-') : null;

  const plainText = afterSection
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join(' '); // 台新頁面同一筆資料常常擠在同一段，先合併成一段文字再用正則切

  // 逐筆比對「代號 TT 名稱 股數 權重%」這個固定順序
  const pattern = /(\d{4})\s+TT\s+([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9\-]*)\s+([\d,]+)\s+(\d+\.?\d*)%/g;
  let m;
  while ((m = pattern.exec(plainText)) !== null) {
    rows.push({
      code: m[1],
      name: m[2].trim(),
      shares: parseInt(m[3].replace(/,/g, '')),
      weight: parseFloat(m[4]),
    });
  }

  // 去重（保留第一次出現）
  const seen = new Set();
  const dedup = rows.filter(r => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });

  return { rows: dedup, snapshotDate, error: dedup.length === 0 ? 'PARSE_EMPTY' : null };
}

module.exports.parseCapitalfundHoldingsHTML = parseCapitalfundHoldingsHTML;
module.exports.parseTaishinHoldingsHTML = parseTaishinHoldingsHTML;
