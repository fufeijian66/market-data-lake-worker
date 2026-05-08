import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchListings } from '../src/sources/listings.ts';
import { fetchEastmoneyHK } from '../src/sources/eastmoney.ts';

const originalFetch = globalThis.fetch;

function restoreFetch(t) {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test('CN listings follow every Eastmoney page and keep exchange prefixes', async (t) => {
  restoreFetch(t);

  const firstPage = [
    { f12: '920001', f13: 0, f14: 'BSE sample' },
    { f12: '900901', f13: 1, f14: 'SH B sample' },
    { f12: '000001', f13: 0, f14: 'SZ A sample' },
    { f12: '688001', f13: 1, f14: 'SH A sample' },
    ...Array.from({ length: 96 }, (_, i) => ({
      f12: String(300000 + i),
      f13: 0,
      f14: `SZ sample ${i}`,
    })),
  ];
  const secondPage = [{ f12: '920002', f13: 0, f14: 'BSE sample 2' }];
  const calls = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(Number(url.searchParams.get('pn')));
    assert.equal(url.searchParams.get('pz'), '100');
    assert.equal(url.searchParams.get('fid'), 'f12');
    assert.equal(url.searchParams.get('fields'), 'f12,f13,f14');

    const page = Number(url.searchParams.get('pn'));
    const diff = page === 1 ? firstPage : page === 2 ? secondPage : [];
    return new Response(JSON.stringify({ data: { total: 101, diff } }), { status: 200 });
  };

  const items = await fetchListings('CN');

  assert.deepEqual(calls, [1, 2]);
  assert.equal(items.length, 101);
  assert.equal(items[0].ticker, 'bj920001');
  assert.equal(items[1].ticker, 'sh900901');
  assert.equal(items[2].ticker, 'sz000001');
  assert.equal(items[3].ticker, 'sh688001');
  assert.equal(items.at(-1).ticker, 'bj920002');
});

test('HK OHLCV uses Eastmoney HK secid instead of Yahoo', async (t) => {
  restoreFetch(t);
  const calls = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, 'push2his.eastmoney.com');
    assert.equal(url.searchParams.get('secid'), '116.00700');
    assert.equal(url.searchParams.get('klt'), '101');

    return new Response(
      JSON.stringify({
        data: {
          klines: ['2026-05-07,470.000,478.000,480.000,468.000,12345'],
        },
      }),
      { status: 200 },
    );
  };

  const rows = await fetchEastmoneyHK('0700.HK', '1d', null);

  assert.equal(calls.length, 1);
  assert.deepEqual(rows, [
    {
      Datetime: '2026-05-07T00:00:00.000Z',
      Open: 470,
      Close: 478,
      High: 480,
      Low: 468,
      Volume: 12345,
    },
  ]);
});
