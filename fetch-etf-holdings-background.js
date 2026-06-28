// netlify/functions/fetch-etf-holdings.js
//
// Netlify Scheduled Function：每天定時自動抓取10檔主動式ETF的持股資料，
// 解析後存入 Netlify Blobs，供前端網站讀取顯示。
//
// ═══════════════════════════════════════════════════════════
// ★ 多來源策略（本次更新重點）★
// 每檔ETF依優先順序設定多個來源，逐一嘗試，第一個成功的就採用：
//   00992A：① 群益投信官網(ID 500) → ② MoneyDJ
//   00982A：① 群益投信官網(ID 399) → ② MoneyDJ
//   00987A：① 台新投信官網            → ② MoneyDJ
//   其餘7檔：僅 MoneyDJ（投信官網禁止爬蟲或純JS無法抓取，詳見對話紀錄查證結果）
//
// ⚠️ 00992A的ID=500、00982A的ID=399 這組對應關係，是在2026/06對話中
//    交叉比對多筆搜尋結果驗證過的，並非憑空假設。若群益投信改版調整ID，
//    這裡需要重新查證更新。
// ═══════════════════════════════════════════════════════════

const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const {
  parseMoneyDJHoldingsHTML,
  parseCapitalfundHoldingsHTML,
  parseTaishinHoldingsHTML,
  verifyCorrectETF,
} = require('./parser.js');

// 每檔ETF的多來源設定，依陣列順序為優先序（先試第一個，失敗才試下一個）
const TARGET_ETFS = [
  {
    code: '00992A', name: '主動群益科技創新',
    sources: [
      { label: '群益投信官網', url: 'https://www.capitalfund.com.tw/etf/product/detail/500/portfolio', parser: parseCapitalfundHoldingsHTML, skipTitleVerify: true },
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00992a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00981A', name: '主動統一台股增長',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00981a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00994A', name: '主動第一金台股優選',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00994a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00987A', name: '主動台新優勢成長',
    sources: [
      { label: '台新投信官網', url: 'https://www.tsit.com.tw/ETF/Home/ETFSeriesDetail/00987A', parser: parseTaishinHoldingsHTML, skipTitleVerify: true },
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00987a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00995A', name: '主動中信台灣卓越',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00995a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00991A', name: '主動復華未來50',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00991a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00988A', name: '主動統一全球創新',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00988a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00982A', name: '主動群益台灣強棒',
    sources: [
      { label: '群益投信官網', url: 'https://www.capitalfund.com.tw/etf/product/detail/399/portfolio', parser: parseCapitalfundHoldingsHTML, skipTitleVerify: true },
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00982a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00985A', name: '主動野村台灣50',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00985a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
  {
    code: '00993A', name: '主動安聯台灣',
    sources: [
      { label: 'MoneyDJ理財網', url: 'https://www.moneydj.com/etf/x/basic/basic0007.xdjhtm?etfid=00993a.tw', parser: parseMoneyDJHoldingsHTML, skipTitleVerify: false },
    ],
  },
];

const DELAY_BETWEEN_REQUESTS_MS = 500;
const FETCH_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
    });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * 嘗試單一來源，回傳成功/失敗結果。
 *
 * skipTitleVerify 的設計考量：
 * verifyCorrectETF() 原本是為 MoneyDJ 設計的防呆機制（核對<title>是否含代號），
 * 但群益投信官網、台新投信官網這兩個來源，每檔ETF用的是「不同網址路徑」存取
 * （例如群益是靠 /500/ vs /399/ 這個ID區分，不是靠同一URL換參數），
 * 串檔風險跟MoneyDJ「同一URL換查詢參數」的情況不同，所以官網來源先不做title驗證，
 * 但仍保留這個選項（skipTitleVerify: false）以便未來如果官網也出現類似問題時可以開啟。
 */
async function tryOneSource(etfCode, source) {
  const result = {
    sourceLabel: source.label,
    success: false,
    holdings: [],
    snapshotDate: null,
    error: null,
  };

  try {
    const res = await fetchWithTimeout(source.url, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      result.error = `HTTP_${res.status}`;
      return result;
    }
    const html = await res.text();

    if (!source.skipTitleVerify) {
      const verify = verifyCorrectETF(html, etfCode);
      if (!verify.verified) {
        result.error = 'WRONG_ETF_RETURNED';
        result.debugTitle = verify.titleFound;
        return result;
      }
    }

    const parsed = source.parser(html);
    if (parsed.error) {
      result.error = parsed.error;
      return result;
    }

    result.success = true;
    result.holdings = parsed.rows;
    result.snapshotDate = parsed.snapshotDate;
  } catch (err) {
    result.error = err.name === 'AbortError' ? 'TIMEOUT' : `FETCH_ERROR: ${err.message}`;
  }

  return result;
}

/**
 * 依優先序逐一嘗試該ETF設定的所有來源，回傳第一個成功的結果。
 * 若全部來源都失敗，回傳最後一個來源的失敗資訊（並附上所有來源各自的失敗原因，方便除錯）。
 */
async function fetchOneETF(etfConfig) {
  const attemptLog = [];

  for (const source of etfConfig.sources) {
    const r = await tryOneSource(etfConfig.code, source);
    attemptLog.push({ source: source.label, success: r.success, error: r.error });

    if (r.success) {
      return {
        code: etfConfig.code,
        name: etfConfig.name,
        fetchedAt: new Date().toISOString(),
        success: true,
        holdings: r.holdings,
        snapshotDate: r.snapshotDate,
        usedSource: source.label,
        attemptLog,
      };
    }

    // 同一檔ETF嘗試下一個來源前也稍微延遲，避免對不同網站的請求過於密集
     await sleep(300);
  }

  // 全部來源都失敗
  return {
    code: etfConfig.code,
    name: etfConfig.name,
    fetchedAt: new Date().toISOString(),
    success: false,
    holdings: [],
    snapshotDate: null,
    error: 'ALL_SOURCES_FAILED',
    attemptLog,
  };
}

// ── 主要排程邏輯 ──
// 排程設定：每天台灣時間 08:30 與 13:30 各執行一次（共兩次）。
// "30 0,5 * * *" = 每天 UTC 00:30 和 05:30（= 台灣 08:30 / 13:30）各觸發一次
const handler = async (event) => {
  const startTime = Date.now();
  const store = getStore({
  name: 'etf-holdings',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_AUTH_TOKEN,
});

  const results = [];
  for (const etfConfig of TARGET_ETFS) {
    const r = await fetchOneETF(etfConfig);
    results.push(r);
    // 每檔ETF之間延遲，避免短時間內連續請求觸發任何網站的異常流量偵測
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  const successCount = results.filter(r => r.success).length;
  const failedDetail = results.filter(r => !r.success).map(r => ({
    code: r.code,
    attempts: r.attemptLog,
  }));

  // 只有成功的資料才覆蓋舊資料；失敗的ETF沿用 Blobs 裡原本存的上一次成功資料
  const existing = await store.get('latest', { type: 'json' }) || { etfs: {} };
  const merged = { etfs: { ...existing.etfs } };

  results.forEach(r => {
    if (r.success) {
      merged.etfs[r.code] = {
        name: r.name,
        snapshotDate: r.snapshotDate,
        fetchedAt: r.fetchedAt,
        holdings: r.holdings,
        source: `${r.usedSource}（自動抓取）`,
      };
    }
  });

  merged.lastRunAt = new Date().toISOString();
  merged.lastRunSummary = {
    total: TARGET_ETFS.length,
    succeeded: successCount,
    failed: TARGET_ETFS.length - successCount,
    failedDetail,
    durationMs: Date.now() - startTime,
  };

  await store.setJSON('latest', merged);

  // 歷史快照（key含日期+時分，因一天跑兩次，避免互相覆蓋）
  if (successCount > 0) {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const timePart = now.toISOString().slice(11, 16).replace(':', '');
    const historyKey = `history-${datePart}-${timePart}`;
    await store.setJSON(historyKey, merged);
  }

  const usedSourceSummary = results
    .filter(r => r.success)
    .map(r => `${r.code}←${r.usedSource}`)
    .join(', ');
  console.log(`[ETF抓取] 完成：成功 ${successCount}/${TARGET_ETFS.length}（${usedSourceSummary}）`);
  if (failedDetail.length) {
    console.log(`[ETF抓取] 失敗明細：${JSON.stringify(failedDetail)}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify(merged.lastRunSummary),
  };
};

module.exports.handler = schedule('30 0,5 * * *', handler);
