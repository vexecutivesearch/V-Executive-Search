type ParsedLocation = {
  raw: string;
  city: string | null;
  stateAbbr: string | null;
  stateName: string | null;
  label: string;
};

const STATE_ABBR: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(STATE_ABBR).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

function normalizeState(token: string): { abbr: string | null; name: string | null } {
  const cleaned = token.trim().replace(/\.$/, "");
  const upper = cleaned.toUpperCase();
  if (STATE_ABBR[upper]) return { abbr: upper, name: STATE_ABBR[upper] };
  const abbr = STATE_NAME_TO_ABBR[cleaned.toLowerCase()];
  if (abbr) return { abbr, name: STATE_ABBR[abbr] };
  return { abbr: null, name: null };
}

export function parseJobLocation(location: string): ParsedLocation | null {
  const raw = location.trim();
  if (!raw || /\b(remote|work from home|wfh)\b/i.test(raw)) return null;

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  if (["US", "USA", "UNITED STATES"].includes(parts[parts.length - 1].toUpperCase())) {
    parts.pop();
  }

  let city: string | null = null;
  let stateAbbr: string | null = null;
  let stateName: string | null = null;

  if (parts.length === 1) {
    const st = normalizeState(parts[0]);
    if (st.abbr) {
      stateAbbr = st.abbr;
      stateName = st.name;
    } else {
      city = parts[0];
    }
  } else {
    city = parts[0];
    const st = normalizeState(parts[1]);
    stateAbbr = st.abbr;
    stateName = st.name;
  }

  const labelParts = [city, stateAbbr ?? stateName].filter(Boolean);
  return {
    raw,
    city,
    stateAbbr,
    stateName,
    label: labelParts.join(", ") || raw,
  };
}

export function apolloLocationQueries(parsed: ParsedLocation): string[] {
  const queries: string[] = [];
  if (parsed.city && parsed.stateAbbr) {
    queries.push(
      `${parsed.city}, ${parsed.stateAbbr}, US`,
      `${parsed.city}, ${parsed.stateAbbr}`,
      `${parsed.city}, US`,
    );
  } else if (parsed.city) {
    queries.push(`${parsed.city}, US`);
  }
  if (parsed.stateName) queries.push(`${parsed.stateName}, US`);
  return [...new Set(queries)];
}

export function formatPersonLocation(person: Record<string, unknown>): string | null {
  const city = String(person.city ?? "").trim();
  const state = String(person.state ?? "").trim();
  if (city && state) return `${city}, ${state}`;
  return city || state || null;
}

export function personMatchesLocation(
  person: Record<string, unknown>,
  targets: ParsedLocation[],
): boolean {
  const personCity = String(person.city ?? "").trim().toLowerCase();
  let personState = String(person.state ?? "").trim().toLowerCase();
  if (STATE_NAME_TO_ABBR[personState]) {
    personState = STATE_NAME_TO_ABBR[personState].toLowerCase();
  }

  for (const target of targets) {
    const targetCity = (target.city ?? "").toLowerCase();
    const targetState = (target.stateAbbr ?? target.stateName ?? "").toLowerCase();

    const cityMatch =
      Boolean(targetCity && personCity) &&
      (targetCity === personCity ||
        personCity.includes(targetCity) ||
        targetCity.includes(personCity));
    const stateMatch =
      Boolean(target.stateAbbr && personState) &&
      target.stateAbbr!.toLowerCase() === personState;

    if (cityMatch && (!target.stateAbbr || stateMatch)) return true;
    if (!targetCity && stateMatch) return true;
  }
  return false;
}

export function collectJobLocations(locations: string[]): ParsedLocation[] {
  const seen = new Set<string>();
  const parsed: ParsedLocation[] = [];
  for (const loc of locations) {
    const p = parseJobLocation(loc);
    if (!p) continue;
    const key = p.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(p);
  }
  return parsed;
}
