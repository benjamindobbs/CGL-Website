# Handoff: CGL-Website, apparel request fields and job packet export to ClassicalKenKen

**From:** a ClassicalKenKen session, 2026-10-29
**For:** a Claude Code session working in `benjamindobbs/CGL-Website` (local checkout: `C:\Users\benja\Documents\GitHub\CGL-Website-1`. The older `CGL-Website` folder next to it is a stale static-site checkout, so don't use it.)
**Owner:** Ben Dobbs

## How to use this

Read this whole file before writing code. There are two pieces of work, in this order:

1. **Apparel decoration fields on the job request form** (`/request/`). Requesters pick design locations, garment type, color and quantities by size. These are new requirements from Ben.
2. **Job packet export.** The lab turns a request into a **job packet** JSON file, which ClassicalKenKen imports as a live job. The new request fields flow straight into the packet.

ClassicalKenKen's side is already built and running on its dev server, including support for the new fields. The packet format is a fixed contract. If something in it doesn't fit, ask Ben rather than changing it on your own. ClassicalKenKen validates every packet against it, and the canonical copy lives in that repo (`.refs/cgl/job-packet.schema.md`). It's reproduced in full below.

## Ground rules

- **Git:** Ben handles all git operations. Don't commit, push or open PRs unless he asks. Work on a branch, not `main`, if he wants one.
- **Don't deploy (`fly.toml`).** The site is live and takes real payments through Stripe. Test locally against a copy of `data/cgl.db`.
- **Follow the repo's existing patterns:**
  - Express routers in `server/routes/`, with `node:sqlite` and schema in `server/db.js`. Use its migration style for new columns and tables.
  - Staff-only API routes use `requireStaff`/`requireAdmin` from `server/staffAuth.js`.
  - Admin pages live under `admin/<tool>/index.html`, using `scripts/admin-shell.js`.
- **Ask Ben before deciding anything in "Decisions for Ben" below.**

## Context in one paragraph

ClassicalKenKen (classicaltech.org) runs the Graphics & Printing work-based learning course. Every live job, station practical and project is a **Work Event**, and students earn micro-credentials by showing skills on Work Events. The CGL website owns the shop's business forms: job requests, orders, inventory and the store. A live job starts on the CGL website, so the lab needs to send that job across.

The integration is **file-based** for now:
1. The CGL website exports one JSON job packet per job.
2. A teacher imports it in ClassicalKenKen (**Work Events → Import Job Packet**: paste the JSON or pick the file).
3. That creates the job as a Work Event, and students run it from the packet's details.

Server-to-server calls can come later (see the end of this file).

## Part 1: apparel decoration fields on the request form

Today the request form (`request/index.html` and `server/routes/requests.js`) has these fields:
- name, email, job name, building, phone;
- **Print Process** (`category`, from `JOB_CATEGORIES` in `server/db.js`);
- a free-text **Quantity**;
- **Needed by** (`<input type="date">`);
- description and file uploads.

**Apparel decoration** means the category is **Screen Printing**, **Embroidery** or **DTF Transfer (Full Color)**. For those three, the form adds the fields below. They're hidden for Banner, Stickers, Decals & Signs, and Not sure yet, which keep today's form unchanged.

| # | Field | Rule |
|---|---|---|
| 1 | **Design location(s)** | **Required, at least one.** Checkboxes: **Full Chest**, **Full Back**, **Front Pocket**, **Sleeve**, **Other**. Ticking Other shows a required "Please specify" text box. More than one can be ticked. |
| 1b | **Number of colors**, per ticked location | **Screen Printing and Embroidery only**, not DTF (full color). It's required for each ticked location: **Screen Printing 1–4** (the presses are 4-color), **Embroidery 1–15**, or **Not sure**. Per location because each print location is its own set of screens or its own stitch file. |
| 2 | **Garment type** | **Required.** **Tee-Shirt**, **Long Sleeve Tee**, **Crew Neck**, **Pull Over**, **Full Zip**, **Polo**, **Other**. Choosing Other shows a required "Please specify" text box. |
| 2a | **Blank (model name or link)** | Optional, free text, e.g. "Gildan 5000" or a supplier product URL. |
| 3 | **Garment color** | **Required**, free text (write-in for now), e.g. "Navy". |
| 4 | **Quantity** | Two modes. **Total**: one whole number (≥ 1). **Qty by Size**: a row per size with a whole-number quantity, where blank or 0 means none; at least one size needs a quantity. The sizes are **YS, YM, YL, YXL, XS, S, M, L, XL, 2XL, 3XL, 4XL**, in that order. The by-size option is offered only for decoration jobs. Other categories keep today's free-text quantity. |

Implementation notes:
- **Validate on the server as well as the client.** `POST /api/requests` (`server/routes/requests.js`) should reject a decoration request that's missing a required field, with the same 400 `{ error }` style the route already uses.
- **Storage is up to you, within `server/db.js` conventions.** A reasonable shape:
  - columns on `job_requests`: `garment_type`, `garment_other`, `blank_ref`, `garment_color`, `qty_mode`;
  - child tables `job_request_locations(request_id, location, other_text, colors)` and `job_request_sizes(request_id, size, qty)`.

  Store `colors` as an integer, or NULL for Not sure, plus a flag; or as text. Pick one and keep it consistent.
- **Show the new fields everywhere a request is shown:** the lab's notification email (`notify()`), the requester's confirmation, the admin list at `/admin/requests/` and the CSV export.
- **Existing requests** have none of these fields. Everything must still work for them, and the packet builder (Part 2) lets the lab fill the gaps.

## Part 2: the job packet builder and export

The smallest thing that tests the handoff: **a job packet builder on the admin Job Requests page, with a Download button.**

The suggested shape is below. Confirm the open points with Ben.

1. **Storage:** a `job_packets` table, one row per job request. It holds:
   - a stable `job_number`;
   - the lab-entered fields the request doesn't have (product type, process details, placement sizes and offsets, Drive links, roles, machines, suggested skills);
   - any lab corrections to the requester's answers;
   - timestamps.
2. **Job number:** assigned once, the first time a packet is saved, and never changed afterward.
   - The re-import rule depends on this: ClassicalKenKen updates the existing job when it sees the same `job_number` again.
   - The example format is `CGL-26-014` (`CGL-<2-digit year>-<3-digit sequence>`). Confirm the format with Ben.
3. **Admin UI:** on `/admin/requests/`, a "Job packet" action per request opens a form.
   - The form is prefilled from the request (see the mapping below), and the lab fills in the rest.
   - **Save** stores it. **Download packet** sends `<job_number>.json` (`Content-Disposition: attachment`).
   - Re-downloading after edits gives the same `job_number` with updated content.
4. **Server:** a route that assembles the packet JSON from the request plus the `job_packets` row and validates it, then returns it as the download. Use `requireAdmin` or `requireStaff`; see the decisions.
5. **Validate before download.**
   - Refuse a download the import would refuse, and show why: a missing `job_number`, a malformed due date, a non-web link, a quantity that isn't a whole number, a color count that isn't allowed or is over the limit for the method.
   - Point out anything the import would only warn about: an unknown method, role, machine, location, garment type, size or skill name. The pick-lists below avoid most of these.

### Mapping from the request to the packet

| Packet field | From | Note |
|---|---|---|
| `order.customer` | `requester_name`, plus `building` if set (e.g. `"Ms. Rivera (Bulkeley HS)"`) | Starts the job's title in ClassicalKenKen. |
| `order.contact` | `email` (and `phone` if set) | |
| `order.due_date` | `needed_by` | It comes from `<input type="date">`, so it's already `YYYY-MM-DD` or `''`. Leave it out when blank. |
| `order.quantities` | **Qty by Size** gives one `{ "size": "M", "qty": 12 }` per size with a quantity. **Total** gives one `{ "qty": 120 }` with no `size`. | For an older request with free-text quantity, the lab enters it in the builder. |
| `order.invoice_ref` | optional, lab-entered | |
| `process.method` | `category` | Screen Printing → `screen`; Embroidery → `embroidery`; DTF Transfer (Full Color) → `dtf`; Banner → `solvent`; Stickers, Decals & Signs → `solvent`; Not sure yet → the lab picks one. |
| `product.type` | `"garment"` for decoration jobs | `"substrate"` for banners and signs (the lab picks). |
| `product.garment_type` | garment type | One of the six labels exactly, or `"Other: <what they typed>"`. |
| `product.brand_style` / `product.blank_url` | blank (model name or link) | If the value is an `http(s)://` link, it goes in `blank_url`; otherwise it goes in `brand_style`. |
| `product.color` | garment color | |
| `placement[]` | one entry per design location | `location` is the label exactly ("Full Chest", "Full Back", "Front Pocket", "Sleeve"), or `"Other: <what they typed>"`. `colors` is the number, or `"not_sure"`, and is left out for DTF. The lab adds `size`, `from` and `notes` in the builder. |
| `is_house` | a checkbox, default off | A house job is the lab's own work, such as store stock. District staff requests are customer jobs. |
| `files.*` | **lab-entered Shared Drive links** | **Don't put Tigris links in the packet.** `presignGetUrl` URLs expire after an hour, but the packet is kept and opened by students for weeks. The Drive folder is the source of truth for files. |
| everything else | lab-entered, with pick-lists from the reference values below | |

Unknown extra fields are kept and ignored, so you can add a field such as `"source": {"system": "cgl-website", "request_id": 12}` for traceability.

## The job packet format (v1.1)

v1.1 adds `product.garment_type`, `product.blank_url`, `placement[].colors`, quantities with no size, and the standard location and garment labels. Every new field is optional, so a v1 packet still imports.

```json
{
  "job_number": "CGL-26-014",
  "is_house": false,
  "order":     { "customer": "Ms. Rivera (Bulkeley HS)", "contact": "rivera@hartfordschools.org", "due_date": "2026-11-14",
                 "quantities": [{ "size": "M", "qty": 12 }, { "size": "L", "qty": 8 }], "invoice_ref": "" },
  "product":   { "type": "garment", "garment_type": "Tee-Shirt", "brand_style": "Gildan 5000", "blank_url": "",
                 "color": "Navy", "supplied_by": "ordered" },
  "process":   { "method": "screen", "ink_or_thread": ["PMS 286 C", "White"], "media_finish": "" },
  "placement": [{ "location": "Full Chest", "colors": 2, "size": "11 in wide", "from": "3 in below collar", "notes": "" },
                { "location": "Sleeve", "colors": "not_sure" }],
  "files":     { "drive_folder_url": "https://drive.google.com/drive/folders/…", "approved_art_url": "", "proof_url": "", "stitch_file_url": "" },
  "assessment":{ "roles_needed": ["job_lead", "buyer_receiver", "qc_inspector", "shipper", "photographer", "production"],
                 "machines": ["screen-press", "x-vactor-exposure"],
                 "suggested_skills": [{ "credential": "Silk Screening", "skill": "Single & Multi-Color Printing" }] }
}
```

A Total-quantity job uses `"quantities": [{ "qty": 120 }]`.

| Field | Type | Rule |
|---|---|---|
| `job_number` | string, ≤ 64 chars | **Required.** This is the identity of the job: re-importing the same number updates that job. |
| `is_house` | boolean | Optional. |
| `order.customer`, `.contact`, `.invoice_ref` | string | Optional. |
| `order.due_date` | `YYYY-MM-DD` | Optional. A malformed value **refuses the import**. |
| `order.quantities` | array of `{size?, qty}` | Optional. If present it must be an array, and each `qty` must be a whole number ≥ 1; otherwise the import is refused. When there's no `size` (or it's empty), the entry is a total for the job. A size outside the standard list imports with a warning. |
| `product.type` | `garment` \| `substrate` | Optional. |
| `product.garment_type` | Tee-Shirt \| Long Sleeve Tee \| Crew Neck \| Pull Over \| Full Zip \| Polo \| `Other: …` | Optional. Any other value imports with a warning. |
| `product.brand_style`, `.color` | string | Optional. |
| `product.blank_url` | `http(s)://` URL or empty | Optional. **A non-web value refuses the import.** |
| `product.supplied_by` | `customer` \| `ordered` | Optional. |
| `process.method` | `screen` \| `dtf` \| `embroidery` \| `solvent` | Optional. Any other value imports with a warning. |
| `process.colors` | whole number ≥ 1, or `"not_sure"` | Optional, for one count for the whole job. Prefer `placement[].colors`. The same per-method maximum applies. |
| `process.ink_or_thread` | array of strings | Optional, e.g. PMS numbers or Madeira thread numbers. |
| `process.media_finish` | string | Optional. |
| `placement` | array of `{location, colors?, size?, from?, notes?}` | Optional. If present it must be an array; anything else refuses the import. |
| `placement[].location` | Full Chest \| Full Back \| Front Pocket \| Sleeve \| `Other: …` | Any other value imports with a warning. |
| `placement[].colors` | whole number ≥ 1, or `"not_sure"` | Optional. The maximum is **4** when `process.method` is `screen` and **15** when it's `embroidery`. Any other value, or a count over the maximum, **refuses the import**. |
| `files.drive_folder_url`, `.approved_art_url`, `.proof_url`, `.stitch_file_url` | `http(s)://` URL or empty | **A non-web value refuses the import**, because these are rendered as links. Students see the Drive folder as "the job folder". |
| `assessment.roles_needed` | array of role codes | An unknown code imports with a warning. |
| `assessment.machines` | array of machine codes | An unknown code imports with a warning. |
| `assessment.suggested_skills` | array of `{credential, skill}` | Names must match exactly (case-insensitive). A pair that doesn't match imports with a warning and is left out. |

**What ClassicalKenKen does on import:**
- **New `job_number`:** creates a live job. It opens that day, and its title is built from the customer and product: total quantity, color, then the blank's model, else the garment type. Examples: `Ms. Rivera (Bulkeley HS) · 20 Navy Gildan 5000`, or `… · 20 Navy Tee-Shirt` with no model. The matched skills become the job's planned skills.
- **Same `job_number` again:** updates the title, the house flag and the stored packet, and adds any new skills. It never removes skills or touches the students assigned to the job.
- **Display:** the job page and each assigned student's page show the garment, color, blank (linked), quantities by size or the total, and each location with its color count ("not sure" where applicable).
- **Students and roles** are assigned in ClassicalKenKen after import. That's where gate clearances are checked, not here.

## Reference values (as of 2026-10-29)

These are the values the import recognizes for the CGL program. Use them as pick-lists. Hard-coding them is fine for this test; ClassicalKenKen has no public endpoint for them yet.

**Design locations:** Full Chest · Full Back · Front Pocket · Sleeve · `Other: <text>`

**Garment types:** Tee-Shirt · Long Sleeve Tee · Crew Neck · Pull Over · Full Zip · Polo · `Other: <text>`

**Sizes for Qty by Size:** YS · YM · YL · YXL · XS · S · M · L · XL · 2XL · 3XL · 4XL (Ben, 2026-10-29). This is a different list from `JERSEY_SIZES`, so define its own constant.

**Color limits per location:** Screen Printing 1–4 · Embroidery 1–15 · or Not sure (Ben, 2026-10-29). Not asked for DTF.

**Methods:** `screen`, `dtf`, `embroidery`, `solvent`

**Roles (`assessment.roles_needed`):**

| Code | Role |
|---|---|
| `job_lead` | Job Lead |
| `buyer_receiver` | Buyer / Receiver |
| `qc_inspector` | QC Inspector |
| `shipper` | Shipper |
| `photographer` | Photographer |
| `production` | Production (operator) |

**Machines (`assessment.machines`):**

| Code | Machine |
|---|---|
| `x-vactor-exposure` | X Vactor exposure unit + washout booth |
| `screen-press` | 4-color screen presses (2) |
| `ryocure-dryer` | Ryocure RC08 dryer |
| `mimaki-txf150` | Mimaki TxF150-75 DTF printer |
| `heater-shaker` | Y8018P heater/shaker |
| `heat-press` | Geo Knight DC heat press |
| `ricoma-mt1501` | Ricoma MT-1501 embroidery |
| `mimaki-cjv200` | Mimaki CJV-200-130 solvent print/cut |
| `epson-et8550` | Epson ET-8550 (film positives) |
| `photo-station` | Photo station (Canon R6 Mark II) |

**Credentials and skills (`assessment.suggested_skills`).** Use these names exactly. Two credentials both have a skill called "Machine Maintenance and Setup", so always send the credential with the skill.

- **Adobe Illustrator:** Working in the Design Industry · Project Setup & Interface · Organizing Documents · Creating & Modifying Visual Elements · Publishing Digital Media
- **Silk Screening:** Prepare Silk Screens · Design Positives & Transparencies · Expose and Wash Out Frames · Align & Set Up Single and Multi-Color Print Jobs · Prepare & Mix Plastisol Ink · Single & Multi-Color Printing · Cure & Finish Prints · Screen Reclaim & Cleanup
- **Embroidery:** Design for Embroidery · Embroidery Digitizing · Machine Maintenance and Setup · Machine Operation
- **Direct to Film:** Design for the DTF Process · Machine Maintenance and Setup · RasterLink 7 Print Setup and Operation · Heater/Shaker Setup Operation and Maintenance · Heat Press Setup Operation and Maintenance · Heat Press Laser Alignment Setup & Utilization · DTF Transfer Application
- **Digital Signmaking & Printing:** Design for Digital Signmaking & Printing · Media & Substrate Management · RasterLink 7 Print/Cut Setup and Operation · Solvent Printer Setup Operation and Maintenance · Media Application · Design for Banners Signs & More
- **Logistics & Operations:** Client Communication · Procurement Shipping & Receiving · Quality Control · Outgoing Packaging & Shipping · Project Management
- **Marketing & Advertisement:** Market Research · Product Photography · Physical & Digital Marketing Design
- **Storefront & Enterprise:** Operate School-Based Enterprise · Inventory Management · Point of Sale · Bookkeeping

A helpful default: preselect suggested skills from the method. For example, `screen` → Silk Screening's Single & Multi-Color Printing, Cure & Finish Prints and Align & Set Up Single and Multi-Color Print Jobs. The lab can edit the selection. Students' role skills are added in ClassicalTech.org, so don't add Logistics or Marketing skills here just because a role is listed.

## Decisions for Ben

1. **Which jobs get packets?** Job requests only, or also orders and jersey rosters, plus house jobs with no request behind them (store stock)? The suggestion is job requests first, with a "New house job" packet that has no request.
2. **Job number format.** `CGL-26-014`: is the year the calendar year or the school year? Does the sequence reset each year?
3. **Who can build and download packets?** Admins only, or student staff too? Student staff are read-only on Job Requests today.
4. **Packet status.** Should it be locked or marked once a request is `complete` or `cancelled`?

## Testing end to end

1. **The request form**, running locally (`npm run dev`) against a copy of `data/cgl.db`:
   - Submit a Screen Printing request with two locations, one of them "Not sure" on colors, and Qty by Size. Check that 5 colors is refused for screen printing but allowed for embroidery.
   - Submit a DTF request with an Other location and a Total quantity. Its color count shouldn't be asked for.
   - Submit a Banner request. It should show none of the new fields.
   - Check that the server rejects a decoration request with no location.
   - Check that the email, the admin list and the CSV show the new fields.
2. **The packet:** build each request's packet and download it.
3. **Import:** hand the files to Ben, or put them where he can reach them. He imports them on the ClassicalKenKen **dev** server: Work-Based Learning → Work Events → Import Job Packet, in the Classical Graphics Lab program.
4. **Expect** each job to be created with no warnings. Its "Job Packet" panel shows the garment, color, sizes and each location's colors, and a student added to it sees the same plus the job-folder link.
5. **Then** edit a packet (for example, change the due date), download it again and re-import. The same job should update, with no duplicate.
6. **Also try** deliberately bad packets: `"proof_url": "file://x"`, `"qty": 0`, `"colors": "lots"`, and `"colors": 5` on a `screen` job. ClassicalKenKen should refuse each with a clear error. The CGL site should already have refused to download them.

## Later, not in this session

- **Gate check.** ClassicalKenKen has a read API for machine clearances, which the Job Sheet will use before giving a student a machine task:

  ```
  GET /api/wbl/programs/:programId/gates?student_id=<id>
  → { "student_id": "12850", "cleared": [{ "machine_code": "screen-press", "label": "…", "cleared_at": 1761700000000,
                                           "cleared_by": "dobbb001", "work_event_id": 42 }] }
  ```

  It needs ClassicalKenKen teacher auth (`Authorization: Bearer <teacher token>`), and ClassicalKenKen sends no CORS headers. So it can only be called from the CGL **server**, not from a browser page, and only with a stored teacher token. That token grants full teacher access, so don't build this until Ben decides how the two servers should authenticate.
- **Student identity.** ClassicalKenKen identifies students by PowerSchool student number with leading zeros removed. `orders.student_id` on the CGL side would need the same normalization for any later cross-system lookups.
- **Server-to-server import**, replacing the file download. It would use the same packet body, posted to `POST /api/wbl/programs/:id/work-events/import`, once auth is settled.
