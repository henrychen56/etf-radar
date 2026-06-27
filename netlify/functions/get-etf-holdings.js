const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const store = getStore({
      name: 'etf-holdings',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });
    const data = await store.get('latest', { type: 'json' });

    if (!data) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: 'no_data_yet',
          message: '排程尚未執行過',
          etfs: {},
        }),
      };
    }

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
