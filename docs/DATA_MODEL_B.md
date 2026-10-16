# Phase B Data Model: Sell & Stock (+ pilot slice of C)

> **Status:** **approved 2026-10-16** (PLAN.md D21). Nothing is built.
> **Scope:** catalog, customers, stock, IMEI/serials, sales, tenders, shifts (Z report), voids and returns. It also covers the pilot slice of Phase C (D11): payment references, image hashes and the manual review queue.
> **Inherits** every convention in [DATA_MODEL.md](DATA_MODEL.md): UUIDv7 ids, `tenant_id` first, composite FKs, santim money, RLS template, audit trigger.
> **Deferred to Phase C:** discounts/promotions, maker-checker requests, bank lookup, the platform-wide reference registry, self-pay links. Columns that will point at them (`discount_id`) exist now as nullable.

---

## 0. Approved choices

| # | Choice | Why |
|---|---|---|
| S1 | **The variant is the unit you sell and stock.** Every product has at least one variant; simple products have one hidden default variant. | One code path for "Coca-Cola 500ml" and "iPhone 15, 128GB, Black". Prices, barcodes, stock and serials all hang off the variant. |
| S2 | **The stock ledger is the truth. Balances are a cache** kept in the same transaction and rebuildable from the ledger. **Stock can go negative**, which raises an alert instead of blocking or hiding it. | Offline sales must never be rejected (PLAN §7.6). Neil Lewz clamps stock with `GREATEST(0, …)`, which silently hides missing goods, the exact thing an owner wants to see. |
| S3 | **Lots are assigned by the server (FEFO) when the sale arrives**, not by the device. Serials are the exception: the cashier scans the exact IMEI at sale. | Two offline devices can't know each other's lot usage. The server sees everything in order. |
| S4 | **Receipt numbers are per device** (`<branch>-<device>-<counter>`, e.g. `B1-C2-000317`), assigned on the device so they work offline. A separate **gapless invoice number** is assigned by the server later, when e-invoicing arrives. | Gapless numbering can't be done offline across devices; e-invoicing (Directive 1142) will need server-issued numbers anyway. |
| S5 | **The server recomputes every sale with `packages/core`.** A mismatch with what the device sent is **flagged, not rejected**. | Never trust client prices (Neil Lewz's online checkout did). But an offline device with a slightly stale price list shouldn't lose a real sale. |
| S6 | **A completed sale is never edited.** Corrections are a **void** (same shift only, reason + PIN) or a **return** (after the shift, linked to the original lines). | This is the theft-control promise. Loyverse and Square let open tickets vanish without a trail (RESEARCH §3). |
| S7 | **Sale lines are snapshots**: name, list price, floor, cost and tax rate at the moment of sale. | Reports and disputes never depend on today's product data. This is the proof behind "I set it at 200,000, not 20,000". |
| S8 | **Payment references are unique per tenant by database index**, normalised before insert. The app checks first so it can show the earlier sale; the index is the last line of defence and turns a race into a Fraud alert. | Neil Lewz checks duplicates only in the POS code, with no unique index (RESEARCH §5). |
| S9 | **Every write from a device is idempotent.** Device-generated ids make replays a no-op, and ledger rows are unique per source line. | Sync retries and double-taps must never double-deduct stock. |

---

## 1. Lessons from Neil Lewz's schema

| Neil Lewz | Here |
|---|---|
| `orders.items` is a JSONB blob | Real `sale_lines` rows with snapshots (S7) |
| Money `numeric(12,2)`, quantities `integer` | Santim `bigint`; quantities `numeric(14,3)` for kg/litre |
| `products.stock_qty` updated by hand, clamped at 0 | Ledger + rebuildable balance cache; negatives allowed and alerted (S2) |
| `stock_sell` has no duplicate guard in `schema.sql`, though a code comment says it's idempotent. The live function is in a `phase25_stock.sql` that isn't in the repo | Unique key per source line on movements (S9). One migration runner (D1) |
| `payments.reference_number` not unique | Unique index per tenant (S8) |
| `order_status_log` written by app code | Audit trigger on every table (DATA_MODEL §3.3) |
| `sku`/`barcode` unique globally, one barcode per product | Barcodes table, many per variant, unique per tenant |
| One `image_url` + `product_images` | Images with thumb, size, hash and label (PLAN §7.7) |

**Worth porting as-is:**
- The `NL-` + 8-character transaction code from an unambiguous alphabet, which fits the Telebirr/CBE remark field. The prefix becomes a tenant setting (D5).
- The "POS payment rejected after goods left" loud alert.
- The low-stock alert that fires only when a sale **crosses** the reorder line, not on every sale.

---

## 2. Catalog

**`app.categories`**: `id` · `tenant_id` · `parent_id null` · `name jsonb` · `sort smallint` · `archived_at`

**`app.products`** (what the customer thinks of as "the item")
| Column | Notes |
|---|---|
| `name jsonb`, `description jsonb` | en/am |
| `category_id` | |
| `brand`, `model` | text; key for electronics and Master Catalog matching |
| `master_product_id null` | Link to the Master Catalog (Phase E) |
| `kind` | enum(`standard`, `serialized`, `weighed`). Serialized = IMEI/serial per unit; weighed = decimal quantity |
| `unit` | enum(`pcs`, `kg`, `g`, `l`, `ml`, `m`) |
| `track_lots`, `track_expiry` | bool (cosmetics, mini-markets) |
| `tax_category` | enum(`standard`, `exempt`, `zero`). Rates live in a platform config table, not in code, because they change (RESEARCH §2) |
| `warranty_days null` | Default for serials |
| `is_sellable`, `archived_at` | |

**`app.product_variants`** (what you sell and count, S1)
| Column | Notes |
|---|---|
| `product_id` | composite FK |
| `attributes jsonb` | e.g. `{"storage":"128GB","color":"Black"}`; `{}` for the default variant |
| `sku text null` | unique per tenant when set |
| `list_price_santim` | Tax-inclusive (PLAN §8) |
| `floor_price_santim null` | Hidden unless the viewer holds `product:view_floor` |
| `last_cost_santim`, `avg_cost_santim` | Updated on receive; used for profit |
| `reorder_level numeric` | |
| `is_default`, `archived_at` | |

**`app.barcodes`**: `tenant_id` · `variant_id` · `code text` · `kind enum(ean13, ean8, upc, code128, internal)` · `unique (tenant_id, code)`. A mini-market item often has a maker barcode *and* a shop label.

**`app.price_tiers`** (wholesale): `variant_id` · `min_qty numeric` · `price_santim` · `label jsonb` ("Wholesale", "Carton") · `unique (variant_id, min_qty)`

**`app.price_history`** (append-only; UPDATE/DELETE revoked like the audit log)
`variant_id` · `field enum(list, floor, tier)` · `tier_id null` · `old_santim` · `new_santim` · `changed_by` · `pin_verification_id null` · `reason text null` · `valid_from timestamptz`
- Answers "what was the price at 14:05 on Tuesday?" for disputes, for server recompute of offline sales (S5), and as the proof behind strikethrough prices.
- A change of more than 50% needs a PIN (PLAN §6.1). Enforced in `packages/core` and checked by a database constraint that `pin_verification_id` is present when the change exceeds 50%.

**`app.product_images`**: `product_id` · `variant_id null` · `label enum(main, front, back, side, detail, box)` · `sort` · `key_full` · `key_thumb` · `bytes` · `width` · `height` · `sha256`. At most 5 per product (plan may lower it). Exactly one `main`.

---

## 3. Customers (core)

**`app.customers`**: `phone text null` (E.164, `unique (tenant_id, phone)` when present) · `name` · `tin null` (business buyers) · `notes` · `marketing_consent bool default false` · `consent_at` · `archived_at`

Sales can be anonymous. Electronics shops will usually record the phone for warranty lookup.

---

## 4. Stock

**`app.suppliers`**: `name` · `phone` · `tin` · `notes` · `archived_at`

**`app.stock_lots`**: `branch_id` · `variant_id` · `lot_code null` · `expires_on date null` · `unit_cost_santim` · `received_at` · `supplier_id null` · `receipt_line_id null`. Created on receive when the product tracks lots or expiry; otherwise a single implicit lot is used.

**`app.stock_movements`** (the ledger; append-only, S2)
| Column | Notes |
|---|---|
| `branch_id`, `variant_id` | |
| `lot_id null`, `serial_unit_id null` | |
| `qty numeric(14,3)` | Signed: + in, − out |
| `unit_cost_santim` | Cost of what moved, for profit |
| `reason` | enum(`opening`, `receive`, `sale`, `void`, `return_restock`, `return_writeoff`, `adjust`, `count`, `write_off`, `transfer_out`, `transfer_in`) |
| `source_type`, `source_id` | e.g. `sale_line`, `receipt_line`, `count_line` |
| `note`, `pin_verification_id null` | Adjustments and write-offs need a reason; large ones a PIN |
| `device_at` | |
| `unique (tenant_id, source_type, source_id, lot_id, serial_unit_id)` | Idempotency (S9). Nulls are treated as equal (`NULLS NOT DISTINCT`, Postgres 15+) |

**`app.stock_balances`** (cache): PK `(tenant_id, branch_id, variant_id, lot_id)` · `qty`. Updated in the same transaction as each movement. A nightly job rebuilds it from the ledger and raises an Error alert on any difference.

**Receiving:** `app.stock_receipts` (`branch_id`, `supplier_id`, `supplier_invoice_no`, `invoice_photo_key`, `status enum(draft, posted)`, `posted_by`, `posted_at`) + `app.stock_receipt_lines` (`variant_id`, `qty`, `unit_cost_santim`, `lot_code`, `expires_on`, `serials text[]` for serialized items). Posting writes the movements, lots and serial units in one transaction.

**Stock counts:** `app.stock_counts` (`branch_id`, `scope jsonb` (all, a category, or a list), `blind bool default true`, `status enum(open, submitted, posted, cancelled)`, `started_by`, `posted_by`) + `app.stock_count_lines` (`variant_id`, `lot_id`, `expected_qty` snapshot at start, `counted_qty`, `counted_by`, `counted_at`).
- **Blind by default:** the counter doesn't see the expected quantity, so they can't just type it in.
- Posting writes a `count` movement for each difference. Differences above a threshold raise a Suspicion alert.

---

## 5. Serials (electronics)

**`app.serial_units`**
| Column | Notes |
|---|---|
| `variant_id`, `branch_id` | |
| `serial text` | IMEI 1 or serial number. `unique (tenant_id, serial)` |
| `serial2 text null` | IMEI 2 on dual-SIM phones |
| `status` | enum(`in_stock`, `sold`, `returned`, `defective`, `written_off`) |
| `received_line_id`, `sold_line_id null` | |
| `unit_cost_santim` | Exact cost of this unit |
| `warranty_until date null` | Set at sale from `warranty_days` |

- IMEIs are checked with the Luhn checksum in `packages/core` (catches typos).
- **Return check:** a returned serial must match the line it was sold on. This prevents swapped returns (PLAN §7.5).
- **Later idea (not in pilot):** a hashed cross-shop IMEI registry, like the reference registry, to flag stolen or double-sold phones. Needs the same legal review.

---

## 6. Sales

**`app.sales`**
| Column | Notes |
|---|---|
| `id` | Device-generated UUIDv7 (S9) |
| `branch_id`, `device_id`, `shift_id` | A sale belongs to an open shift |
| `receipt_no` | Per device (S4). `unique (tenant_id, receipt_no)` |
| `invoice_no null` | Server-assigned, later (e-invoicing) |
| `customer_id null` | |
| `sold_by` | staff id |
| `status` | enum(`parked`, `completed`, `voided`, `pending_approval`) |
| `channel` | enum(`pos`, `self_pay`, `online`) |
| `subtotal_santim`, `tax_santim`, `rounding_santim`, `total_santim` | Tax is computed out of tax-inclusive prices |
| `device_at`, `completed_at` | |
| `recompute_status` | enum(`match`, `mismatch_flagged`) (S5) |
| `void_reason`, `voided_by`, `void_pin_verification_id` | |

- `parked` = a held ticket ("customer went to get money"). **Parked tickets are audited too**, so deleting one leaves a trace. Abandoned parked tickets are listed in the Z report.
- `pending_approval` = an offline sale with a PIN-protected action, settled after sync (D18).

**`app.sale_lines`** (snapshots, S7)
| Column | Notes |
|---|---|
| `sale_id`, `line_no` | |
| `variant_id`, `serial_unit_id null` | |
| `name_snapshot jsonb` | Name as printed on the receipt |
| `qty numeric(14,3)` | |
| `list_price_santim` | List price at sale |
| `unit_price_santim` | What was actually charged per unit |
| `price_source` | enum(`list`, `tier`, `discount`, `negotiated`, `below_floor`). Decided by `packages/core` (PLAN §6.2) |
| `floor_at_sale_santim null`, `tier_id null`, `discount_id null` | |
| `tax_category`, `tax_rate_bp` | Rate in basis points (1500 = 15%) at sale time |
| `line_total_santim` | |
| `cost_santim` | Filled by the server after FEFO allocation (S3), for profit |
| `pin_verification_id null` | Required when `price_source = below_floor` |
| `flags text[]` | e.g. `above_list`, `price_stale`, `discount_not_applied` |

**`app.sale_tenders`** (split payments allowed)
| Column | Notes |
|---|---|
| `sale_id` | |
| `method` | enum(`cash`, `telebirr`, `cbe`, `cbe_birr`, `boa`, `dashen`, `awash`, `other_bank`, `dube`, `store_credit`, `gateway`) |
| `amount_santim` | |
| `cash_given_santim`, `change_santim` | Cash only |
| `status` | enum(`received`, `pending_verification`, `verified`, `rejected`, `fake`). Cash is `received` immediately |
| `payment_account_id null` | Which of the shop's accounts it was paid into |
| `reference_id null` | → `payment_references`. **Required for every digital method** (D8) |

**`app.payment_accounts`**: `provider` · `account_number` · `holder_name` · `is_active`. Written only from the console (the setting is permanently locked, PLAN §4). Changes raise an alert.

**Cash rounding:** a tenant setting (none, 0.50 birr, 1 birr). The difference is stored in `rounding_santim` so the Z report still balances.

---

## 7. Payment references (pilot slice of C)

**`app.payment_references`**
| Column | Notes |
|---|---|
| `provider` | enum, same list as digital tender methods |
| `reference` | Normalised: uppercase, spaces removed, OCR confusions fixed by provider rules (PLAN §7.1) |
| `unique (tenant_id, provider, reference)` | S8 |
| `capture_method` | enum(`qr`, `link`, `ocr`, `manual`). `manual` is flagged (D8) |
| `amount_read_santim`, `payer_name_read`, `receipt_date_read` | What the QR/OCR read |
| `raw_text`, `ocr_confidence` | Evidence for the review screen |
| `image_key null`, `image_sha256`, `image_phash bigint` | 64-bit perceptual hash |
| `check_results jsonb` | The ✔/✖/⚠ rows shown in the stepper (PLAN §7.1) |
| `platform_hash null` | HMAC for the cross-shop registry, filled in Phase C |
| `bank_lookup jsonb null` | Phase C |

- **Image reuse check:** an exact `sha256` match is a Fraud alert. A near `phash` match (Hamming distance ≤ 6 using `bit_count(a # b)`) is a Suspicion alert. A per-tenant scan is fine at pilot volumes. An index can come later.

**`app.payment_reviews`**: `tender_id` · `decision enum(verified, rejected, fake)` · `reason text` · `reviewed_by` · `via enum(app, telegram)` · `created_at`. One tender can have several reviews (e.g. rejected, then verified after the customer re-sends). The tender's status follows the latest review.

---

## 8. Shifts and Z report

**`app.shifts`**: `branch_id` · `device_id` (the till) · `opened_by` · `opened_at` · `opening_float_santim` · `closed_by` · `closed_at` · `status enum(open, closing, closed)` · `z_no` (sequential per branch, server-assigned on close) · `notes`. **One open shift per device.** A shift can be opened offline.

**`app.cash_movements`** (pay-in / pay-out during a shift): `shift_id` · `direction enum(in, out)` · `amount_santim` · `reason enum(petty_expense, owner_withdrawal, float_top_up, other)` · `note` · `staff_id` · `pin_verification_id null`. Without these, expected cash is wrong every time someone pays a delivery man from the drawer.

**`app.shift_counts`**: `shift_id` · `method` · `expected_santim` · `counted_santim` · `difference_santim` · `denominations jsonb` (cash: count per note and coin, e.g. `{"200":5,"100":12,"50":3,…}`) · `counted_by`.
- Expected per method = opening float (cash) + tenders − refunds ± cash movements. Computed in `packages/core`.
- A non-zero difference above a tenant threshold raises a Suspicion alert (PLAN §6.3).
- **The Z report is a view** over the shift and is sent to Telegram on close. It contains:
  - totals per method, counted vs expected
  - voids, returns and below-floor sales
  - parked tickets left open

---

## 9. Voids and returns

**Void** (S6): only while the sale's shift is open. Requires a reason and `sale:void` with PIN. It reverses the stock movements (`reason = void`) and marks the tenders. A voided sale stays visible, struck through, in every list.

**Undo** (SCREENS.md U3, approved D22): within 10 seconds of completing a sale, the same cashier on the same device can void it without a PIN. It is stored as a void with `void_reason = undo` and counted separately in the Z report.

**`app.returns`**: `original_sale_id` · `branch_id` · `shift_id` · `reason enum(defective, wrong_item, changed_mind, warranty, other)` · `note` · `processed_by` · `pin_verification_id` · `status enum(completed, voided)`

**`app.return_lines`**: `sale_line_id` (composite FK) · `qty` · `serial_unit_id null` (must equal the sold serial) · `disposition enum(restock, write_off, defective)` · `refund_santim`. Total returned per line can't exceed the quantity sold (checked by a constraint trigger).

**`app.return_refunds`**: `return_id` · `method` · `amount_santim` · `reference_id null`. Store credit comes later.

---

## 10. Numbering

**`app.number_sequences`**: PK `(tenant_id, scope, kind)` · `next_value`
- `scope` = a device id (for receipt numbers, S4) or a branch id (for Z numbers, return numbers).
- Receipt counters are handed out on the device and confirmed on sync. The server rejects a receipt number already used by another sale (unique index) and raises an Error alert, which can only happen if a device's storage was wiped.

---

## 11. Tests Phase B must ship with

- **`packages/core` unit tests:**
  - tax extraction from inclusive prices
  - rounding
  - `price_source` classification for every row of PLAN §6.2
  - FEFO allocation
  - IMEI Luhn
  - Z report expected amounts
  - reference normalisation and OCR fixes per provider
- **Idempotency:** replaying the same sale twice produces one sale and one set of movements.
- **Offline ordering:** sales from two devices arriving out of order give the same balances.
- **Ledger rebuild:** the balance cache after a random sequence equals a rebuild from the ledger.
- **pgTAP leak tests** for every new table, and composite FK tests across tenants.
- **Constraint tests:**
  - a below-floor line without a PIN verification fails
  - returning more than was sold fails
  - returning a different serial fails
  - a duplicate reference fails
