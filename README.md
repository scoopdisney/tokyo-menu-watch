# tokyo-menu-watch

Daily price watch for Tokyo Disneyland and Tokyo DisneySea restaurant menus, from Oriental Land Co.'s official site (tokyodisneyresort.jp, English pages). Separate from `disney-menu-watch` (Disneyland) and `wdw-menu-watch` (Walt Disney World).

**How it works**
1. Reads the restaurant lists for both parks and finds every `/en/<park>/restaurant/detail/<id>/` link.
2. Opens each venue's menu page (`/en/<park>/restaurant/food/<id>/`) and collects its `/en/food/<id>/` item links.
3. Fetches every unique item page once (items are shared across venues) — name, ¥ price, availability dates, notes.
4. Diffs against the committed `data/current.csv` by **venue id + item id**. Price moves go to `data/price-changes.csv`; renames, new and removed items go into the summary. Posts one summary comment per day on the `daily-log` issue, plus an immediate comment when anything changes.

**Files** — `data/current.csv` (all rows), `data/tokyo-disneyland.csv`, `data/tokyo-disneysea.csv`, `data/price-changes.csv`, `data/last-daily.txt` (daily-summary marker).

**Columns** — Pulled, Restaurant, Park, Area, Item, PriceJPY, PriceText, PriceUSD, Availability, Note, FoodId, VenueId, Source. `PriceUSD` uses the day's open.er-api.com rate and is blank if that lookup fails.

**Scope notes** — These are the "recommended menu" listings Oriental Land publishes, not necessarily every SKU sold. Hotel restaurants are not covered in v1. Prices include Japanese consumption tax.

## If the runner is blocked
Oriental Land's CDN (Akamai) silently drops some datacenter IP ranges (connections open but never answer). The scan preflights the homepage and aborts with a clear comment if that happens. If it happens on every run, options in order of effort: (1) re-run — GitHub runners rotate IPs; (2) add a `FETCH_VIA` reverse proxy; (3) a self-hosted runner on a residential/home connection.

## Manual run / parser debugging
Actions → "Daily Tokyo Disney Resort menu scan" → Run workflow → set `debug` to `1`. The log will then contain the text of one venue menu page and the raw HTML of one item page so selectors can be adjusted without site access.
