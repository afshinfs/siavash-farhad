// Keep the request independent of the worker so the failover rules can be tested.
export async function retrieveOverpass(query, mode, progress, fetchImpl = fetch, timeoutMs = 45000) {
  const servers = {
    fosssgis: { name: 'FOSSGIS', url: 'https://overpass-api.de/api/interpreter' },
    privatecoffee: { name: 'Private.coffee', url: 'https://overpass.private.coffee/api/interpreter' },
  };
  const order = mode === 'auto'
    ? [servers.fosssgis, servers.privatecoffee]
    : [servers[mode] || servers.privatecoffee];
  const attempts = [];

  for (const { name, url } of order) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let failure;
    let transient = false;
    progress(attempts.length ? attempts[0].error + ' Trying ' + name + '…' : 'Retrieving OSM roads and rivers from ' + name + '…');

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!response.ok) {
        failure = name + ' returned HTTP ' + response.status + '.';
        transient = [500, 502, 503, 504].includes(response.status);
      } else {
        if (Number(response.headers.get('Content-Length') || 0) > 20000000) {
          throw Error('The OSM response is too large. Use a smaller area.');
        }
        const text = await response.text();
        if (text.length > 20000000) throw Error('The OSM response is too large. Use a smaller area.');
        let raw;
        try { raw = JSON.parse(text); }
        catch { throw Error(name + ' returned a response that could not be read as JSON.'); }
        if (!raw || !Array.isArray(raw.elements)) throw Error(name + ' returned an invalid Overpass response.');
        if (raw.remark) {
          failure = name + ' returned incomplete data. ' + String(raw.remark).slice(0, 160);
          transient = /timed? ?out|timeout|too busy|server (?:load|overloaded)/i.test(raw.remark);
        } else {
          attempts.push({ server: name, endpoint: url, status: 'complete' });
          return { raw, endpoint: url, attempts };
        }
      }
    } catch (error) {
      transient = controller.signal.aborted || error instanceof TypeError;
      failure = controller.signal.aborted ? name + ' timed out.'
        : error instanceof TypeError ? name + ' could not be reached.'
        : error.message;
    } finally {
      clearTimeout(timer);
    }
    attempts.push({ server: name, endpoint: url, status: 'failed', error: failure });
    if (!transient) break;
  }

  throw Error(attempts.map(attempt => attempt.error).join(' ') + ' Retry later or open a saved OSM JSON or GeoJSON file.');
}
