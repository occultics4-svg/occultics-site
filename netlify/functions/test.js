const https = require('https');

exports.handler = async function(event) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'NO API KEY FOUND' })
    };
  }

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Say hello' }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ 
            status: res.statusCode,
            response: data.substring(0, 500),
            keyPrefix: apiKey.substring(0, 10) + '...'
          })
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: e.message })
      });
    });

    req.write(requestBody);
    req.end();
  });
};
