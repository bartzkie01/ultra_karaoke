const https = require('https');
const vm = require('vm');
const q = 'let it go karaoke';
const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
function extractJsonValue(html, key) {
  const index = html.indexOf(key);
  if (index === -1) return null;
  const start = html.indexOf('{', index);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let currentQuote = null;
  let escape = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (escape) { escape = false; continue; }
    if (char === '\\') { escape = true; continue; }
    if (inString) {
      if (char === currentQuote) { inString = false; currentQuote = null; }
      continue;
    }
    if (char === '"' || char === "'") { inString = true; currentQuote = char; continue; }
    if (char === '{') { depth += 1; }
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}
function isKaraokeTitle(title) {
  const lower = title.toLowerCase();
  return lower.includes('karaoke') || lower.includes('カラオケ') || lower.includes('karaoké');
}
https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } }, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const jsonString = extractJsonValue(data, 'ytInitialData');
    console.log('jsonString length', jsonString?.length);
    if (!jsonString) return;
    try {
      const obj = new vm.Script('(' + jsonString + ')').runInNewContext({});
      const found = [];
      function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.videoRenderer?.videoId) {
          const title = node.videoRenderer.title?.runs?.map(r => r.text).join('') || node.videoRenderer.title?.simpleText || '';
          if (isKaraokeTitle(title)) found.push({ videoId: node.videoRenderer.videoId, title });
        }
        for (const value of Object.values(node)) walk(value);
      }
      walk(obj);
      console.log('found count', found.length);
      console.log(JSON.stringify(found.slice(0,10), null, 2));
    } catch (err) {
      console.error('parse error', err.message);
    }
  });
}).on('error', e => console.error(e));
