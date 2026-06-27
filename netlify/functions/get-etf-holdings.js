// netlify/functions/get-etf-holdings.js
//
// 一般（非排程）Netlify Function：前端網站開啟頁面時呼叫這個 endpoint，
// 讀取 Scheduled Function 之前存好的最新ETF持股資料。
//
// 呼叫方式（前端 fetch）：
//   const res = await fetch('/.netlify/functions/get-etf-holdings');
//   const data = await res.json();

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  // CORS header：允許前端網頁呼叫（雖然同網域通常不需要，但保留以防萬一用不同網域測試）
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const store = getStore('etf-holdings');
    const data = await store.get('latest', { type: 'json' });

    if (!data) {
      // 排程還沒執行過第一次，回傳明確的「尚無資料」狀態，
      // 前端可以據此顯示「自動抓取尚未執行，請使用貼上更新」的提示，而不是顯示空白或報錯。
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'no_data_yet',
          message: '排程尚未執行過，或尚無任何成功抓取的資料',
          etfs: {},
        }),
      };
    }

    // 計算資料新鮮度，方便前端直接判斷要顯示綠/橘/紅燈
    const lastRunAt = data.lastRunAt ? new Date(data.lastRunAt) : null;
    const hoursAgo = lastRunAt ? (Date.now() - lastRunAt.getTime()) / 3600000 : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'ok',
        lastRunAt: data.lastRunAt,
        hoursAgo: hoursAgo !== null ? Math.round(hoursAgo * 10) / 10 : null,
        lastRunSummary: data.lastRunSummary || null,
        etfs: data.etfs || {},
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        status: 'error',
        message: err.message,
      }),
    };
  }
};
