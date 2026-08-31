# Sentinel — Ingestion File Specification

Two supported modes. **Both produce identical results** — the pipeline normalizes either into the same store.

- **Mode A (recommended day-to-day):** drop the **raw Precoro exports** as-is. The importer auto-detects
  each file by its header signature, strips Precoro's 2 instruction rows, whitelists columns, normalizes
  units, and upserts idempotently.
- **Mode B:** one combined workbook, **`Sentinel_Ingestion_Template.xlsx`** (provided) — 8 tabs, fixed
  headers. Use for initial load, for QatarMP until its Precoro exports exist, and for the data Precoro
  cannot produce (deliveries, planning params, category owners).

---

## 1. Files required, and how often

| # | Dataset | Source | Cadence | Blocking? |
|---|---|---|---|---|
| 1 | **Item master** | Precoro `ITEMS.xlsx` | On change (weekly), **daily if prices move** | Yes — the SKU→Recipe Ref bridge |
| 2 | **Inventory on hand** | Precoro `Inventory_All_Dimensions…xlsx` | **Daily** | Yes |
| 3 | **Open POs** | Precoro `Open_POs…xlsx` | **Daily** | Yes |
| 4 | **Consumption / balances** | Precoro `Inventory_Report…xlsx` (start, in, out, end) | **Daily**, plus a 3-month history at load | Yes — seeds the rate |
| 5 | **Deliveries** | **deliveries dashboard** (not Precoro) | **Daily preferred**; weekly / monthly / quarterly / YTD accepted | Yes — the demand primitive |
| 6 | **Suppliers** | Precoro `suppliers…xlsx` | On change | No (but lead times matter) |
| 7 | **Planning parameters** | Excel DDS / template tab 7 | **Initial seed only** — owned in Sentinel after go-live | No |
| 8 | **Category owners** | `Category_Buyers.xlsx` / template tab 8 | On change | No |

**Not ingested:** GRN/PO PDFs (attached to tasks as evidence), ingredient/recipe yield stats (v1.5, and the
supplied `ingredient-stats.xlsx` is corrupt — invalid stylesheet XML — so it must be re-exported).

---

## 2. Column whitelist — what is kept, and what is discarded

The importer uses an **allow-list per file kind**. Anything not listed is dropped at the boundary and never
persisted, never logged.

**Explicitly discarded from the supplier file (security requirement, not a preference):**
`Bank Account Number · Account Holder Name · Bank Name · Bank Address · Sort Code · IBAN · SWIFT/BIC ·
ABA Routing Number · IFSC Code · Tax ID · PAN · Business Registration Number · Legal Address · Phone Number`.
Sentinel has no use for banking or tax identity data, and holding it creates liability with no benefit.
The importer must **assert** these fields are absent from the persisted row (test-enforced).

Also discarded: Precoro's empty planning columns (`Minimum Stock Level`, `Reorder To`, `Need To Order` —
verified 100% empty across 11,317 rows), UI-only columns, and any column with a null rate above 99%.

**Kept per kind:** as listed in §3.1. Header matching is **trimmed, case-folded and alias-mapped**, never exact-string.

---

## 3. Combined template — `Sentinel_Ingestion_Template.xlsx`

**Headers are verbatim Precoro export headers** wherever the field comes from Precoro (blue in the template),
so a Precoro export can be pasted straight in and one alias map serves both modes. Orange columns are
**Sentinel-only** — Precoro cannot supply them.

### 3.1 Canonical header map (importer alias table)
| Sentinel field | **Exact Precoro header** | Source export |
|---|---|---|
| `sku` | `SKU *` / `SKU` | Items / Inventory / POs |
| `itemName` | `Item Name *` / `Item Name` | Items |
| `price` | `Price *` | Items |
| `currency` | `Currency` · `Item Currency` · `Currency code *` | Items / Inventory / Suppliers |
| `inactive` | `Inactive * [1=Inactive 0=Active]` | Items |
| `unit` | `Unit` | Items |
| `itemType` | `Item Type *` | Items |
| `category` | `Category Name (required if the Code field is empty)` | Items |
| `ingredientFamily` | `Ingredient Family Name (required if the Code field is empty)` | Items |
| `recipeRef` | `Recipe Ref Name (required if the Code field is empty)` | Items |
| `brand` · `size` · `caseCount` | `Brand*` · `Size*` · `Case Count*` | Items *(Precoro-required; previously omitted)* |
| `conversionFactor` | `Conversion Factor*` | Items |
| `convertedUnit` | `Converted Unit Name (required if the Code field is empty)` | Items |
| `businessUnit` | `Business Unit Name ` **(trailing space — must be trimmed)** | Items |
| `warehouse` | `Warehouse` | Inventory All Dimensions |
| `qty` | `Quantity` | Inventory All Dimensions |
| `value` | `Gross Total, Document Currency` | Inventory All Dimensions |
| `startBalance` | `Start Balance` | Inventory Report |
| `goodsIn` | `Transfers - Goods In` | Inventory Report |
| `goodsOut` | `Transfers - Goods Out` | Inventory Report |
| `endBalance` | `End Balance` | Inventory Report |
| `poNumber` | `Purchase Order #` | Open POs |
| `expectedDelivery` | `Purchase Order Delivery Date` | Open POs |
| `receiptDates` | `Receipt Dates` **(plural — may hold several dates)** | Open POs |
| `ordered` / `received` / `waiting` | `Ordered (Quantity)` · `Received (Quantity)` · `Waiting (Quantity)` | Open POs |
| `supplierName` | `Name *` / `Supplier` | Suppliers / POs |
| `supplierActive` | `Active * [0=Inactive 1=Active]` | Suppliers |
| `leadTimeDays` | `Delivery Period` | Suppliers |
| `moqValue` | `Minimum Order Total` | Suppliers |
| `paymentTerms` | `Payment Terms` (free text → parse to days) | Suppliers |

### 3.2 Gaps in the Precoro exports — these must be closed
| Gap | Impact | Fix |
|---|---|---|
| **Open POs has no PO creation date** (creation date is only a report *filter*, per the filename) | **True lead time cannot be measured** — only lateness vs promised date. Cripples the lead-time learning that closes the 84% gap | Add `Purchase Order Creation Date` to the Precoro export config *(cutover W1)*; template column provided |
| **Open POs has no PO status** (cancellations/closures invisible) | Dead commitments read as live expected stock — the supply axis renders "Follow-up with Supplier" on cancelled POs and the loop never learns the truck is not coming (§14.6c) | Add `Purchase Order Status` to the Precoro export config *(priority-1 ADD, cutover W1)*; template column provided; vocabulary `OPEN \| CANCELLED \| CLOSED`, unknown values quarantine (`PO_STATUS_UNKNOWN`) |
| **Open POs has no unit price / currency** | Price variance and realized savings cannot be computed from POs | Add to export config; template columns provided |
| **Inventory Report has no period columns** | Consumption cannot be dated; rates cannot be seeded | Supply `Period Start` / `Period End` (template) or derive from the export filename |
| **Inventory `Type` column is unusable** — every row reads `All` | Quarantine/staging would be counted as available | `Warehouse Kind` supplied by Sentinel *(cutover W5)* |
| **`Receipt Dates` is plural** | Multiple receipts per line | Importer splits and takes earliest/latest per rule; partials become separate receipt records |
| **Supplier export repeats `Name` / `Email Address`** across contact blocks | Duplicate header collision | Importer de-duplicates positionally; contact blocks are discarded anyway |
| **`Business Unit Name ` has a trailing space** | Naive header match fails | Importer trims and case-folds all headers |
| Precoro planning fields `Minimum Stock Level` · `Reorder To` · `Need To Order` | 100% empty across 11,317 rows | Ignored by the allow-list; Sentinel originates planning |

### 3.3 Tab summary
| Tab | Grain | Sentinel-only columns |
|---|---|---|
| `1_ITEMS` | one row per SKU | Shelf Life Days · Preferred SKU flag · Nutrition Approved · Production Approved · Banned |
| `2_INVENTORY` | SKU × warehouse | **Warehouse Kind** |
| `3_CONSUMPTION` | SKU × period | **Period Start · Period End** |
| `4_OPEN_POS` | PO line | **PO Creation Date · Unit Price · Currency** |
| `5_SUPPLIERS` | supplier | Payment Term Days · Banned |
| `6_DELIVERIES` | tenant × period | *from deliveries dashboard* — the demand primitive; any granularity |
| `7_PLANNING_PARAMS` | recipe ref | *entirely Sentinel* — Precoro's planning fields are empty |
| `8_CATEGORY_OWNERS` | category × tenant | *entirely Sentinel* |

Upload is **per tenant** — one workbook per tenant, or add a `Tenant` column and the importer splits.

## 4. Pipeline behaviour (identical for both modes)

`detect kind → strip instruction rows → whitelist columns → normalize units → validate → idempotent upsert →
recompute engine → seal day snapshot → fire auto-tasks → write import log`

**Validation gates (a failing file is quarantined whole, never half-applied):**
- required columns present; row count within ±40% of the previous run for that kind
- every SKU resolves to a Recipe Ref → otherwise an **unmapped-SKU report** (does not block, but surfaces)
- every unit resolves against the canonical catalog → unresolved spellings raise a data-health item
- numeric fields parse; negative on-hand flagged; duplicate keys collapsed deterministically
- `Payment Terms` free text parsed to days ("SOA +45 Days" → 45); unparsable → flagged, not guessed
- **deliveries variance guard:** a value more than ±50% from the trailing 7-day mean requires confirmation
  (protects against 1,200 typed for 12,000 — a single keystroke that would corrupt every status)

**Idempotency:** re-importing the same file changes nothing. Keys — Item `SKU`; Inventory `SKU+Warehouse`;
PO `PO Number+SKU`; Supplier `Supplier ID` (H7/A8 identity key; `Name` is the interim until the amended R4 ships the column); Deliveries `Tenant+Date`; Params `Recipe Ref+Tenant`.

**Day basis and canonical dates (H4/H9 — A10, normative):** the one canonical temporal form is
**date-only, UTC, `YYYY-MM-DD`**. Date-only columns pass through unchanged; datetime columns are converted
**at the boundary** using the **tenant timezone — an explicit tenant setting** (fixed offset or IANA), never
the importing server's local zone; a datetime that carries no zone is read as tenant-local wall time by the
same explicit setting, and a value that cannot be converted is quarantined, not guessed. Downstream (feedback,
engine day math, calendars) everything works on these canonical dates in **integer day units** — no
milliseconds, no half-day rounding. Deliveries are entered as **calendar-day actuals** (what really arrived on
each date, including non-working days). The engine's working-month basis `WD` is **per-tenant and
per-period, calendar-derived** from the tenant's week pattern and closures (Ramadan, holidays) — for a tenant
without a real calendar it remains the workbook's flat convention of 22. The deliveries divisor and the
magnification basis are always the **same** per-period count, so the conversion cancels exactly (§14.4b
invariant), and a flat-calendar tenant produces byte-identical output to today.

**Module isolation (rev 1.2 directive):** the Integration Gateway is a **module** in the Sentinel container
(§8/§14.15 of the build spec). It owns its queue, watchdog and circuit breaker — a failing file kind, a
poison row or a hung parser quarantines **that kind only** and never blocks the other kinds, the engine
recompute for already-imported kinds, or any other module. Reconciliation of proposal tasks (the feedback
module, build spec §14.6) also runs as its own failure domain inside the same import run: if it faults, the
import still lands, signals are deferred, and a `MODULE_FAULT` card appears on Data Health.

**Transfer-plan reconciliation feed (rev 1.4 boundary):** the Consumption report's `Transfers - Goods In` /
`Transfers - Goods Out` aggregates double as the reconciliation feed for approved transfer plans (build spec
§14.7): quantities matching an approved plan's destination and tolerance flip it to `RECONCILED`; a miss in
the expected window flags `MISMATCH` and routes a follow-up task. **No new dataset is required** — the daily
Consumption drop already carries everything the boundary needs. Quarantine dispositions and cycle-count
corrections need no feed either: they post in Precoro and surface through the ordinary Inventory and
Consumption drops.

---

## 5. Minimum viable daily drop
Inventory + Open POs + Consumption + **Deliveries**, with a current Item master as the bridge.
Missing any one degrades predictably: no consumption → refs read Inactive/NC; no inventory → no status or
valuation; no POs → shortages overstated and no follow-up; **no deliveries → the whole engine goes flat**
(this is the one to alarm on).
