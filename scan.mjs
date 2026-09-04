// Tokyo Disney Resort menu price watch — SEPARATE from disney-menu-watch (Disneyland) and wdw-menu-watch.
// Source: Oriental Land Co.'s official site, tokyodisneyresort.jp (English pages).
//   1. Venue discovery: /en/tdl/restaurant/list.html and /en/tds/restaurant/list.html
//      -> every link matching /en/<park>/restaurant/detail/<venueId>/
//   2. Per venue: /en/<park>/restaurant/food/<venueId>/  -> every link matching /en/food/<foodId>/
//   3. Per unique food item: /en/food/<foodId>/ (fetched ONCE, shared across venues) -> name, ¥ price,
//      availability window, and the item's own "Available Restaurants" list.
// Prices are in JPY (whole yen). Diff key is venueId + foodId (Disney's own ids), so a renamed item is
// reported as a RENAME instead of vanishing — this closes the rename blind spot the US trackers have.
// Output: data/current.csv, data/tokyo-disneyland.csv, data/tokyo-disneysea.csv, data/price-changes.csv, summary.md

import fs from 'node:fs/promises';

const HOST = 'https://www.tokyodisneyresort.jp';
const PARKS = { tdl: 'Tokyo Disneyland', tds: 'Tokyo DisneySea' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEBUG = process.env.DEBUG_HTML === '1';
const TIMEOUT_MS = 30000;

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString().slice(0, 16).replace('T', ' ');
const HEADER = ['Pulled', 'Restaurant', 'Park', 'Area', 'Item', 'PriceJPY', 'PriceText', 'PriceUSD', 'Availability', 'Note', 'FoodId', 'VenueId', 'Source'];
const LOG_HEADER = ['Detected', 'Restaurant', 'Park', 'Item', 'Old Price', 'New Price', 'Change', 'Percent', 'FoodId', 'Source'];
