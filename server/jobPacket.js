// Job packets: the JSON file ClassicalKenKen imports as a live Work Event
// (format v1.1; the canonical spec is .refs/cgl/job-packet.schema.md in the
// ClassicalKenKen repo). This module holds the reference values that import
// recognizes, builds a draft packet from a job request, and checks a packet the
// way the import will: an error refuses the import, a warning imports anyway
// with a note. routes/packets.js does the storage and job numbering.
//
// This site sends the proposed v1.2 fields, which ClassicalKenKen doesn't read
// yet (the import keeps and ignores unknown fields):
//   order.quantities[].color   per-color quantities; product.color then holds
//                              the colors joined with ", "
//   product.size / .surface    finished size and surface of a banner/sticker/sign
//                              (Wall | Window | Floor | Vehicle | Sign |
//                              "Other: ..." | "Not sure yet")
//   placement[].method         a location done another way than process.method
//                              (team names/numbers: DTF or embroidery); its color
//                              limit follows this method
//   placement[].name_number    name_number | name | number: roster names/numbers
//                              go here
//   roster                     { name, jersey_style, players: [{ name, number,
//                              size, color, info }] }
// validatePacket checks colors against each location's own method, as v1.2
// will. A v1.1 import checks against process.method only, so it would refuse
// an embroidered pocket with more than 4 colors on a screen-printing job.
const {
    DECORATION_CATEGORIES, DESIGN_LOCATIONS, GARMENT_TYPES, APPAREL_SIZES, SURFACE_TYPES, JERSEY_OPTIONS,
} = require('./db');
const { etDate } = require('./etDate');

// --- Reference values (ClassicalKenKen, as of 2026-10-29) --------------------
// Hard-coded: ClassicalKenKen has no public endpoint for them yet.

const METHODS = [
    { code: 'screen', label: 'Screen printing' },
    { code: 'dtf', label: 'DTF transfer' },
    { code: 'embroidery', label: 'Embroidery' },
    { code: 'solvent', label: 'Solvent print / cut' },
];
const METHOD_CODES = METHODS.map((m) => m.code);

// Request category -> process.method. "Not sure yet" has none: the lab picks.
const CATEGORY_METHOD = {
    'Screen Printing': 'screen',
    'Embroidery': 'embroidery',
    'DTF Transfer (Full Color)': 'dtf',
    'Banner': 'solvent',
    'Stickers, Decals & Signs': 'solvent',
};

// Max placement[].colors per method. Methods not listed here don't take a
// color count (DTF is full color), so it's left out of the export for them.
const METHOD_COLOR_LIMITS = { screen: 4, embroidery: 15 };

const ROLES = [
    { code: 'job_lead', label: 'Job Lead' },
    { code: 'buyer_receiver', label: 'Buyer / Receiver' },
    { code: 'qc_inspector', label: 'QC Inspector' },
    { code: 'shipper', label: 'Shipper' },
    { code: 'photographer', label: 'Photographer' },
    { code: 'production', label: 'Production (operator)' },
];

const MACHINES = [
    { code: 'x-vactor-exposure', label: 'X Vactor exposure unit + washout booth' },
    { code: 'screen-press', label: '4-color screen presses (2)' },
    { code: 'ryocure-dryer', label: 'Ryocure RC08 dryer' },
    { code: 'mimaki-txf150', label: 'Mimaki TxF150-75 DTF printer' },
    { code: 'heater-shaker', label: 'Y8018P heater/shaker' },
    { code: 'heat-press', label: 'Geo Knight DC heat press' },
    { code: 'ricoma-mt1501', label: 'Ricoma MT-1501 embroidery' },
    { code: 'mimaki-cjv200', label: 'Mimaki CJV-200-130 solvent print/cut' },
    { code: 'epson-et8550', label: 'Epson ET-8550 (film positives)' },
    { code: 'photo-station', label: 'Photo station (Canon R6 Mark II)' },
];

// Names must match exactly. Two credentials share "Machine Maintenance and
// Setup", so a suggested skill is always a { credential, skill } pair.
const CREDENTIALS = [
    { credential: 'Adobe Illustrator', skills: ['Working in the Design Industry', 'Project Setup & Interface', 'Organizing Documents', 'Creating & Modifying Visual Elements', 'Publishing Digital Media'] },
    { credential: 'Silk Screening', skills: ['Prepare Silk Screens', 'Design Positives & Transparencies', 'Expose and Wash Out Frames', 'Align & Set Up Single and Multi-Color Print Jobs', 'Prepare & Mix Plastisol Ink', 'Single & Multi-Color Printing', 'Cure & Finish Prints', 'Screen Reclaim & Cleanup'] },
    { credential: 'Embroidery', skills: ['Design for Embroidery', 'Embroidery Digitizing', 'Machine Maintenance and Setup', 'Machine Operation'] },
    { credential: 'Direct to Film', skills: ['Design for the DTF Process', 'Machine Maintenance and Setup', 'RasterLink 7 Print Setup and Operation', 'Heater/Shaker Setup Operation and Maintenance', 'Heat Press Setup Operation and Maintenance', 'Heat Press Laser Alignment Setup & Utilization', 'DTF Transfer Application'] },
    { credential: 'Digital Signmaking & Printing', skills: ['Design for Digital Signmaking & Printing', 'Media & Substrate Management', 'RasterLink 7 Print/Cut Setup and Operation', 'Solvent Printer Setup Operation and Maintenance', 'Media Application', 'Design for Banners Signs & More'] },
    { credential: 'Logistics & Operations', skills: ['Client Communication', 'Procurement Shipping & Receiving', 'Quality Control', 'Outgoing Packaging & Shipping', 'Project Management'] },
    { credential: 'Marketing & Advertisement', skills: ['Market Research', 'Product Photography', 'Physical & Digital Marketing Design'] },
    { credential: 'Storefront & Enterprise', skills: ['Operate School-Based Enterprise', 'Inventory Management', 'Point of Sale', 'Bookkeeping'] },
];

// Starting selections for a new packet, editable in the builder. Role skills
// (Logistics, Marketing) are added in ClassicalKenKen, so they aren't here.
const DEFAULT_MACHINES = {
    screen: ['x-vactor-exposure', 'screen-press', 'ryocure-dryer', 'epson-et8550'],
    dtf: ['mimaki-txf150', 'heater-shaker', 'heat-press'],
    embroidery: ['ricoma-mt1501'],
    solvent: ['mimaki-cjv200'],
};
const skillsOf = (credential, skills) => skills.map((skill) => ({ credential, skill }));
const DEFAULT_SKILLS = {
    screen: skillsOf('Silk Screening', ['Align & Set Up Single and Multi-Color Print Jobs', 'Single & Multi-Color Printing', 'Cure & Finish Prints']),
    dtf: skillsOf('Direct to Film', ['RasterLink 7 Print Setup and Operation', 'Heater/Shaker Setup Operation and Maintenance', 'DTF Transfer Application']),
    embroidery: skillsOf('Embroidery', ['Machine Maintenance and Setup', 'Machine Operation']),
    solvent: skillsOf('Digital Signmaking & Printing', ['RasterLink 7 Print/Cut Setup and Operation', 'Solvent Printer Setup Operation and Maintenance', 'Media Application']),
};

const FILE_FIELDS = ['drive_folder_url', 'approved_art_url', 'proof_url', 'stitch_file_url'];

// --- Job numbers -------------------------------------------------------------

// The school year an instant falls in, as its starting calendar year: July 1
// (ET) onward is the next school year. 2026-10-29 -> 2026 (SY 2026-27).
function schoolYear(ms = Date.now()) {
    const [y, m] = etDate(ms).split('-').map(Number);
    return m >= 7 ? y : y - 1;
}

// CGL-26-014. seq past 999 just grows a digit.
function formatJobNumber(year, seq) {
    return `CGL-${String(year % 100).padStart(2, '0')}-${String(seq).padStart(3, '0')}`;
}

// --- Packet shape ------------------------------------------------------------

const str = (v) => (v == null ? '' : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const list = (v) => (Array.isArray(v) ? v : []);
// Whole numbers become numbers; anything else stays as typed so the checks
// below can quote it back.
const wholeOrRaw = (v) => (/^\d+$/.test(str(v)) ? Number(str(v)) : str(v));

// Coerces whatever the builder sent into the stored packet body (the v1.1
// format minus job_number). Unknown fields are dropped; blank rows are removed.
// Values aren't checked here — a draft may be saved with problems, it just
// can't be downloaded (see validatePacket).
function normalizePacket(input) {
    const p = input && typeof input === 'object' ? input : {};
    const order = p.order || {};
    const product = p.product || {};
    const process = p.process || {};
    const files = p.files || {};
    const assessment = p.assessment || {};
    const roster = p.roster || {};
    return {
        is_house: p.is_house === true,
        order: {
            customer: str(order.customer),
            contact: str(order.contact),
            due_date: str(order.due_date),
            quantities: list(order.quantities)
                .map((q) => ({ size: str(q?.size), qty: wholeOrRaw(q?.qty), color: str(q?.color) }))
                .filter((q) => q.size || q.qty !== ''),
            invoice_ref: str(order.invoice_ref),
        },
        product: {
            type: str(product.type),
            garment_type: str(product.garment_type),
            brand_style: str(product.brand_style),
            blank_url: str(product.blank_url),
            color: str(product.color),
            supplied_by: str(product.supplied_by),
            size: str(product.size),
            surface: str(product.surface),
        },
        process: {
            method: str(process.method),
            ink_or_thread: strList(process.ink_or_thread),
            media_finish: str(process.media_finish),
        },
        placement: list(p.placement)
            .map((pl) => {
                const out = { location: str(pl?.location) };
                const colors = str(pl?.colors);
                if (colors) out.colors = colors === 'not_sure' ? colors : wholeOrRaw(colors);
                out.size = str(pl?.size);
                out.from = str(pl?.from);
                out.notes = str(pl?.notes);
                out.method = str(pl?.method);
                out.name_number = str(pl?.name_number);
                return out;
            })
            .filter((pl) => pl.location || pl.colors !== undefined || pl.size || pl.from || pl.notes),
        roster: {
            name: str(roster.name),
            jersey_style: str(roster.jersey_style),
            players: list(roster.players)
                .map((pl) => ({ name: str(pl?.name), number: str(pl?.number), size: str(pl?.size), color: str(pl?.color), info: str(pl?.info) }))
                .filter((pl) => pl.name || pl.number),
        },
        files: Object.fromEntries(FILE_FIELDS.map((k) => [k, str(files[k])])),
        assessment: {
            roles_needed: strList(assessment.roles_needed),
            machines: strList(assessment.machines),
            suggested_skills: list(assessment.suggested_skills)
                .map((s) => ({ credential: str(s?.credential), skill: str(s?.skill) }))
                .filter((s) => s.credential && s.skill),
        },
    };
}

// The packet ClassicalKenKen receives. `source` is an extra field the import
// keeps and ignores, there for tracing a job back to this site.
function assemblePacket(jobNumber, body, source) {
    const p = normalizePacket(body);
    // A color count only means something for screen printing and embroidery
    // (or before a method is picked).
    const takesColors = (pl) => {
        const method = pl.method || p.process.method;
        return !method || method in METHOD_COLOR_LIMITS;
    };
    const order = {
        ...p.order,
        quantities: p.order.quantities.map((q) => ({
            ...(q.size ? { size: q.size } : {}),
            qty: q.qty,
            ...(q.color ? { color: q.color } : {}),
        })),
    };
    if (!order.due_date) delete order.due_date;
    return {
        job_number: jobNumber || '',
        is_house: p.is_house,
        order,
        product: p.product,
        process: p.process,
        placement: p.placement.map((pl) => {
            const out = { ...pl };
            if (!takesColors(pl)) delete out.colors;
            if (!out.method) delete out.method;
            if (!out.name_number) delete out.name_number;
            return out;
        }),
        files: p.files,
        assessment: p.assessment,
        ...(p.roster.players.length ? { roster: p.roster } : {}),
        source: { system: 'cgl-website', ...source },
    };
}

const otherLabel = (text) => `Other: ${text}`;
// A standard label exactly, or "Other: <text>".
const isStandardLabel = (value, labels) =>
    labels.some((l) => l !== 'Other' && l === value) || /^Other: \S/.test(value);
const isWebUrl = (s) => /^https?:\/\/\S+$/i.test(s);
function isIsoDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Checks an assembled packet the way ClassicalKenKen's import does.
// errors: the import would refuse it. warnings: it imports, with a note.
function validatePacket(packet) {
    const errors = [];
    const warnings = [];
    const { order, product, process, placement, files, assessment } = packet;

    if (!packet.job_number) errors.push('No job number yet. Save the packet to assign one.');
    else if (packet.job_number.length > 64) errors.push('The job number is over 64 characters.');

    if (order.due_date !== undefined && !isIsoDate(order.due_date)) {
        errors.push(`Due date "${order.due_date}" isn't a valid YYYY-MM-DD date.`);
    }
    order.quantities.forEach((q, i) => {
        const which = q.size ? `size ${q.size}` : `quantity line ${i + 1}`;
        if (!Number.isInteger(q.qty) || q.qty < 1) errors.push(`The ${which} needs a whole number of at least 1 (got "${q.qty}").`);
        if (q.size && !APPAREL_SIZES.includes(q.size)) warnings.push(`Size "${q.size}" isn't one of the standard sizes.`);
    });

    if (product.blank_url && !isWebUrl(product.blank_url)) errors.push('The blank link must start with http:// or https://.');
    for (const k of FILE_FIELDS) {
        if (files[k] && !isWebUrl(files[k])) errors.push(`The ${k.replace(/_url$/, '').replace(/_/g, ' ')} link must start with http:// or https://.`);
    }

    if (process.method && !METHOD_CODES.includes(process.method)) warnings.push(`Unknown method "${process.method}".`);
    if (product.type && !['garment', 'substrate'].includes(product.type)) warnings.push(`Unknown product type "${product.type}".`);
    if (product.supplied_by && !['customer', 'ordered'].includes(product.supplied_by)) warnings.push(`Unknown "supplied by" value "${product.supplied_by}".`);
    if (product.garment_type && !isStandardLabel(product.garment_type, GARMENT_TYPES)) {
        warnings.push(`Garment type "${product.garment_type}" isn't a standard label.`);
    }

    const roster = packet.roster || { players: [] };
    placement.forEach((pl, i) => {
        const name = pl.location || `Placement ${i + 1}`;
        if (!isStandardLabel(pl.location, DESIGN_LOCATIONS)) {
            warnings.push(pl.location ? `Location "${pl.location}" isn't a standard label.` : `${name} has no location.`);
        }
        if (pl.method && !METHOD_CODES.includes(pl.method)) warnings.push(`${name}: unknown method "${pl.method}".`);
        if (pl.name_number) {
            if (!(pl.name_number in JERSEY_OPTIONS)) warnings.push(`${name}: unknown name/number option "${pl.name_number}".`);
            if (!roster.players.length) warnings.push(`${name} is set for names/numbers, but the packet has no roster.`);
            const missing = roster.players.filter((p) => !p.number).length;
            if (missing && pl.name_number !== 'name') warnings.push(`${name}: ${missing} player${missing === 1 ? ' has' : 's have'} no number.`);
        }
        if (pl.colors === undefined || pl.colors === 'not_sure') return;
        const method = pl.method || process.method;
        const limit = METHOD_COLOR_LIMITS[method];
        if (!Number.isInteger(pl.colors) || pl.colors < 1) errors.push(`${name}: colors must be a whole number of at least 1, or Not sure (got "${pl.colors}").`);
        else if (limit && pl.colors > limit) errors.push(`${name}: ${pl.colors} colors is over the ${limit}-color limit for ${method}.`);
    });
    if (roster.players.length && !['male', 'female'].includes(roster.jersey_style)) {
        warnings.push(`Roster jersey style "${roster.jersey_style}" isn't male or female.`);
    }

    for (const code of assessment.roles_needed) {
        if (!ROLES.some((r) => r.code === code)) warnings.push(`Unknown role "${code}".`);
    }
    for (const code of assessment.machines) {
        if (!MACHINES.some((m) => m.code === code)) warnings.push(`Unknown machine "${code}".`);
    }
    for (const s of assessment.suggested_skills) {
        const cred = CREDENTIALS.find((c) => c.credential.toLowerCase() === s.credential.toLowerCase());
        if (!cred || !cred.skills.some((k) => k.toLowerCase() === s.skill.toLowerCase())) {
            warnings.push(`Skill "${s.credential}: ${s.skill}" doesn't match a credential skill, so the import will leave it out.`);
        }
    }
    return { errors, warnings };
}

// --- Drafts ------------------------------------------------------------------

// Default machines and skills for every method the job uses, e.g. a screen
// job with DTF names gets the screen and DTF sets.
function defaultAssessment(methods) {
    const used = [...new Set(methods.filter(Boolean))];
    const skills = used.flatMap((m) => DEFAULT_SKILLS[m] || []);
    return {
        roles_needed: ROLES.map((r) => r.code),
        machines: [...new Set(used.flatMap((m) => DEFAULT_MACHINES[m] || []))],
        suggested_skills: skills.filter((s, i) => skills.findIndex((x) => x.credential === s.credential && x.skill === s.skill) === i),
    };
}

// A first packet for a job request, prefilled from the requester's answers.
// `decoration` is getRequestDecoration(request.id).
function draftFromRequest(r, { locations, colors, roster }) {
    const method = CATEGORY_METHOD[r.category] || '';
    let quantities = [];
    if (colors.length) {
        // One entry per color (total) or per color and size.
        quantities = colors.flatMap((c) => (c.sizes.length
            ? c.sizes.map((s) => ({ size: s.size, qty: s.qty, color: c.color }))
            : [{ size: '', qty: c.qty, color: c.color }]));
    } else if (/^\d+$/.test(r.quantity.trim()) && Number(r.quantity) > 0) {
        // An older or non-apparel free-text quantity that's just a number.
        quantities = [{ size: '', qty: Number(r.quantity) }];
    }
    const blankIsUrl = /^https?:\/\//i.test(r.blank_ref);
    return normalizePacket({
        is_house: false,
        order: {
            customer: r.building ? `${r.requester_name} (${r.building})` : r.requester_name,
            contact: r.phone ? `${r.email}, ${r.phone}` : r.email,
            due_date: r.needed_by,
            quantities,
        },
        product: {
            type: DECORATION_CATEGORIES.includes(r.category) ? 'garment' : method === 'solvent' ? 'substrate' : '',
            garment_type: r.garment_type === 'Other' ? otherLabel(r.garment_other) : r.garment_type,
            brand_style: blankIsUrl ? '' : r.blank_ref,
            blank_url: blankIsUrl ? r.blank_ref : '',
            color: r.garment_color,
            size: r.item_size,
            surface: r.surface_type === 'Other' ? otherLabel(r.surface_other) : r.surface_type,
        },
        process: { method },
        placement: locations.map((l) => ({
            location: l.location === 'Other' ? otherLabel(l.other_text) : l.location,
            colors: l.colors,
            method: l.method,
            name_number: l.name_number,
        })),
        roster: { name: r.roster_name, jersey_style: r.jersey_style, players: roster },
        assessment: defaultAssessment([method, ...locations.map((l) => l.method)]),
    });
}

// A house job: the lab's own work (store stock) with no request behind it.
function houseDraft() {
    return normalizePacket({
        is_house: true,
        order: { customer: 'Classical Graphics Lab' },
        assessment: defaultAssessment([]),
    });
}

// Everything the builder's pick-lists need, in one payload.
const REFERENCE = {
    methods: METHODS,
    roles: ROLES,
    machines: MACHINES,
    credentials: CREDENTIALS,
    locations: DESIGN_LOCATIONS,
    garmentTypes: GARMENT_TYPES,
    sizes: APPAREL_SIZES,
    surfaces: SURFACE_TYPES,
    jerseyOptions: JERSEY_OPTIONS,
    colorLimits: METHOD_COLOR_LIMITS,
    defaultMachines: DEFAULT_MACHINES,
    defaultSkills: DEFAULT_SKILLS,
};

module.exports = {
    REFERENCE, schoolYear, formatJobNumber,
    normalizePacket, assemblePacket, validatePacket, draftFromRequest, houseDraft,
};
