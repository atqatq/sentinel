# Precoro Custom Report Specification — for Sentinel ingestion

**Purpose:** define the exact reports to build in Precoro so Sentinel receives every data point it needs.
Five reports. Where a column is marked **[ADD]**, it is **not** in the current standard export and must be
added — three of these are hard blockers for Sentinel's learning loop.

**Conventions for every report:** export as `.xlsx` · one header row · no merged cells · no grand-total row ·
if Precoro injects instruction/tip rows, leave them (the importer strips them) · headers may keep Precoro's
native decoration (`SKU *`, `Conversion Factor*`) — the importer trims, case-folds and alias-maps · **never
include banking or tax identity fields** (see R4).

---

## R1 · Item Master  → `items_<date>.xlsx`
**Grain:** one row per SKU. **Cadence:** on change; daily if prices move.

| # | Header (exact) | Required | Notes |
|---|---|---|---|
| 1 | `SKU *` | ● | join key everywhere |
| 2 | `Item Name *` | ● | |
| 3 | `Price *` | ● | current unit price |
| 4 | `Currency` | ● | item currency (mixed BHD/AED/SAR/USD exists today) |
| 5 | `Inactive * [1=Inactive 0=Active]` | ● | 548 currently inactive |
| 6 | `Unit` | ● | 50 raw spellings → normalized |
| 7 | `Supplier` | ○ | default supplier |
| 8 | `Item Type *` | ● | Inventory / Non-Inventory / Service / Shipping / Tax |
| 9 | `Category Name (required if the Code field is empty)` | ● | drives ownership + routing |
| 10 | `Ingredient Family Name (…)` | ○ | |
| 11 | `Recipe Ref Name (…)` | ● | **planning grain** — must be populated for every active SKU |
| 12 | `Brand*` | ● | Precoro-required |
| 13 | `Size*` | ● | Precoro-required |
| 14 | `Case Count*` | ● | Precoro-required |
| 15 | `Conversion Factor*` | ● | SKU qty × CF → planning unit |
| 16 | `Converted Unit Name (…)` | ● | |
| 17 | `Business Unit Name` | ○ | trailing space in current export — trimmed |
| 18 | `Country of Origin Name` | ○ | local vs imported |
| 19 | `Shelf Life Days` | **[ADD]** | fresh-food order cap; 0 = non-perishable |
| 20 | `Preferred SKU for Recipe Ref [1/0]` | **[ADD]** | which SKU we actually buy — 734 multi-SKU refs need this |
| 21 | `Nutrition Approved [1/0]` | **[ADD]** | filter + gate |
| 22 | `Production Approved [1/0]` | **[ADD]** | filter + gate |
| 23 | `Banned [1/0]` | **[ADD]** | lifecycle |

*If Precoro cannot hold 19–23 as custom fields, supply them via template tabs 1/7 instead.*

---

## R2 · Inventory by Warehouse  → `inventory_<date>.xlsx`
**Grain:** one row per SKU × warehouse. **Cadence:** daily. **Include zero-quantity rows** (they are how
Sentinel detects Zero Stock — omitting them makes shortages invisible).

| # | Header (exact) | Required | Notes |
|---|---|---|---|
| 1 | `Warehouse` | ● | all 26 locations |
| 2 | `SKU` | ● | |
| 3 | `Item Name` | ○ | |
| 4 | `Unit` | ● | |
| 5 | `Quantity` | ● | on hand |
| 6 | `Price` | ● | |
| 7 | `Item Currency` | ● | |
| 8 | `Gross Total, Document Currency` | ● | valuation |
| 9 | `Warehouse Kind` | **[ADD]** | COMPANY / 3PL / STAGING / QUARANTINE / CONSIGNMENT / VIRTUAL / INACTIVE. **Precoro's `Type` column is unusable — every row reads `All`.** Without this, quarantined and staging stock is wrongly counted as available |

**Do not include:** `Minimum Stock Level`, `Reorder To`, `Need To Order` — verified 100% empty across 11,317
rows. Sentinel originates all planning.

---

## R3 · Consumption / Stock Movement  → `consumption_<from>_<to>.xlsx`
**Grain:** one row per SKU for a period. **Cadence:** daily (rolling) + a **3-month history at load**.
This report seeds every per-SKU consumption rate — it is the most important recurring export.

| # | Header (exact) | Required | Notes |
|---|---|---|---|
| 1 | `SKU` | ● | |
| 2 | `Item Name` | ○ | |
| 3 | `Unit` | ● | |
| 4 | `Start Balance` | ● | |
| 5 | `Transfers - Goods In` | ● | |
| 6 | `Transfers - Goods Out` | ● | |
| 7 | `End Balance` | ● | consumption = Start + In − End − Out |
| 8 | `Ordered, Total` | ○ | cross-check vs R5 |
| 9 | `Waiting for the Delivery, Total` | ○ | cross-check |
| 10 | `Period Start` | **[ADD]** | **the current export has no period columns** — the range is only a report parameter, so consumption arrives undated and cannot seed a rate |
| 11 | `Period End` | **[ADD]** | as above |

*If Precoro cannot emit the period as columns, encode it in the filename as `consumption_YYYY-MM-DD_YYYY-MM-DD.xlsx` and the importer will parse it.*

---

## R4 · Suppliers  → `suppliers_<date>.xlsx`
**Grain:** one row per supplier. **Cadence:** on change.

| # | Header (exact) | Required | Notes |
|---|---|---|---|
| 1 | `Name *` | ● | |
| 2 | `Active * [0=Inactive 1=Active]` | ● | |
| 3 | `Delivery Period` | ● | **lead time — 194 of 230 are blank today** |
| 4 | `Minimum Order Total` | ○ | |
| 5 | `Payment Terms` | ● | free text ("SOA +45 Days") → parsed to days |
| 6 | `Currency code *` | ● | |
| 7 | `Country` | ○ | local vs import routing |
| 8 | `Payment Term Days` | **[ADD]** | numeric; enables DPO without fragile text parsing |
| 9 | `Banned [1/0]` | **[ADD]** | |

**Must be excluded — do not add these columns to the report:**
`Bank Account Number · Account Holder Name · Bank Name · Bank Address · Sort Code · IBAN · SWIFT/BIC Code ·
ABA Routing Number · IFSC Code · Tax ID · PAN · Business Registration Number · Legal Address · Phone Number ·
all contact-block columns`. Sentinel discards them at ingestion; excluding them at source is cleaner and
removes the liability entirely.

---

## R5 · Purchase Orders  → `pos_<date>.xlsx`
**Grain:** one row per PO line. **Cadence:** daily.
**Scope change:** the current export is *Open* POs only. Sentinel needs **open and recently closed**
(rolling 90 days) — closed POs are where realized lead time, fill rate and price variance come from.

| # | Header (exact) | Required | Notes |
|---|---|---|---|
| 1 | `Purchase Order #` | ● | reconciliation key |
| 2 | `Supplier` | ● | |
| 3 | `SKU` | ● | |
| 4 | `Item Name` | ○ | |
| 5 | `Unit` | ● | |
| 6 | `Purchase Order Delivery Date` | ● | promised date |
| 7 | `Receipt Dates` | ● | plural — importer splits partials |
| 8 | `Ordered (Quantity)` | ● | |
| 9 | `Received (Quantity)` | ● | |
| 10 | `Waiting (Quantity)` | ● | open position → double-order guard |
| 11 | `Purchase Order Creation Date` | **[ADD]** ⚠ | **BLOCKER. Creation date is only a report filter today, not a column. Without it, realized lead time cannot be measured — which disables the learning that closes the 84% lead-time gap** |
| 12 | `Unit Price` | **[ADD]** ⚠ | **BLOCKER for price variance and realized savings** |
| 13 | `Currency` | **[ADD]** | |
| 14 | `Purchase Order Status` | ○ | open / closed / cancelled |

---

## Priority of the [ADD] columns

| Priority | Column | Report | Consequence if not added |
|---|---|---|---|
| **1 — blocker** | `Purchase Order Creation Date` | R5 | No lead-time learning. The 84% gap stays manual forever |
| **1 — blocker** | `Unit Price` | R5 | No price variance, no realized savings validation |
| **1 — blocker** | `Period Start/End` | R3 | Consumption undated → rates cannot be seeded → **engine cannot run** |
| **2 — high** | `Warehouse Kind` | R2 | Quarantine/staging counted as available → over-stated coverage |
| **2 — high** | `Recipe Ref` populated on every active SKU | R1 | Unmapped SKUs drop out of planning entirely |
| **3 — important** | `Shelf Life Days`, `Preferred SKU` | R1 | Fresh over-ordering; proposals cannot name what to buy |
| **4 — useful** | `Payment Term Days`, approval flags, `Banned` | R1/R4 | Manual parsing; approval filters unavailable |

## Not obtainable from Precoro at all
**Deliveries** — the single demand primitive — comes from **deliveries dashboard**, not Precoro. Sentinel
accepts them daily, weekly, monthly, quarterly or YTD and normalizes to a per-day rate. **Planning parameters**
(lead/safety/order-frequency/MOQ) are originated and owned in Sentinel; Precoro's planning fields stay empty
by design.
