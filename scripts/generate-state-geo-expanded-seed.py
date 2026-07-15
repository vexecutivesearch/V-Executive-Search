#!/usr/bin/env python3
"""
Generate DB-backed state geo seed data from Census/OMB sources.

Business markets and preferred scrape hubs are inputs. County facts, CBSA county
sets, place county splits, and independent-city handling are derived from the
official source files downloaded below.
"""

from __future__ import annotations

import csv
import json
import re
import textwrap
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
CENSUS_DIR = ROOT / "data" / "census"
SEED_TS = ROOT / "src" / "lib" / "state-geo-expanded-seed.ts"
SEED_JSON = ROOT / "src" / "lib" / "state-geo-expanded-seed.generated.json"
COVERAGE_JSON = ROOT / "src" / "lib" / "state-geo-expanded-coverage.json"
COVERAGE_MD = ROOT / "docs" / "state-geo-expanded-coverage.md"

SOURCE_URLS = {
    "cbsaWorkbook": "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
    "acsGeography": "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
}

LOCAL_FILES = {
    "cbsaWorkbook": CENSUS_DIR / "list1_2023.xlsx",
    "acsGeography": CENSUS_DIR / "Geos20235YR.txt",
}

STATE_NAMES = {
    "AL": "Alabama",
    "AR": "Arkansas",
    "AZ": "Arizona",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DC": "District of Columbia",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "IL": "Illinois",
    "IN": "Indiana",
    "KY": "Kentucky",
    "MD": "Maryland",
    "MI": "Michigan",
    "MS": "Mississippi",
    "NC": "North Carolina",
    "NJ": "New Jersey",
    "NY": "New York",
    "OH": "Ohio",
    "PA": "Pennsylvania",
    "SC": "South Carolina",
    "TN": "Tennessee",
    "TX": "Texas",
    "VA": "Virginia",
    "WV": "West Virginia",
}

STATE_ABBRS = {name: abbr for abbr, name in STATE_NAMES.items()}

LOCALITY_ALIASES = {
    ("nashville", "TN"): ("nashville-davidson metropolitan government",),
}

SUFFIXES = (
    "city",
    "town",
    "village",
    "borough",
    "cdp",
    "municipality",
    "township",
)


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower().replace("–", "-")).strip()


def strip_locality_suffix(value: str) -> str:
    base = clean_locality_name(value)
    for suffix in SUFFIXES:
        base = re.sub(rf"\s+{suffix}$", "", base)
    return norm(base)


def clean_locality_name(value: str) -> str:
    return norm(re.sub(r"\s*\([^)]*\)\s*", " ", value))


def locality_keys(value: str, state_abbr: str) -> set[tuple[str, str]]:
    return {
        (clean_locality_name(value), state_abbr),
        (strip_locality_suffix(value), state_abbr),
    }


def county_token(county_name: str, state_abbr: str) -> str:
    clean = county_name
    for suffix in (
        " County",
        " Parish",
        " Borough",
        " Municipio",
        " city",
        " City",
    ):
        if clean.endswith(suffix):
            clean = clean[: -len(suffix)]
            break
    return f"{clean}, {state_abbr}"


def display_hub(city: str, city_state: str, market_state: str) -> str:
    city = city.strip()
    if re.search(r",\s*[A-Z]{2}$", city):
        return city
    if city_state != market_state:
        return f"{city}, {city_state}"
    return city


def parse_city_state(value: str, fallback_state: str) -> tuple[str, str]:
    match = re.search(r"^(.*?),\s*([A-Z]{2})$", value.strip())
    if match:
        return match.group(1).strip(), match.group(2).upper()
    return value.strip(), fallback_state


@dataclass(frozen=True)
class MarketSpec:
    name: str
    hubs: tuple[str, ...]
    cbsa_titles: tuple[str, ...] = ()
    metro_division_titles: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class StateSpec:
    state_abbr: str
    default_market: str
    markets: tuple[MarketSpec, ...]

    @property
    def state_name(self) -> str:
        return STATE_NAMES[self.state_abbr]


SPECS: tuple[StateSpec, ...] = (
    StateSpec(
        "FL",
        "West Palm Beach",
        (
            MarketSpec(
                "Miami / Fort Lauderdale",
                ("Miami", "Fort Lauderdale", "Hollywood", "Pembroke Pines", "Miramar", "Coral Springs", "Pompano Beach", "Hialeah"),
                metro_division_titles=("Miami-Miami Beach-Kendall, FL", "Fort Lauderdale-Pompano Beach-Sunrise, FL"),
                aliases=("south florida", "miami-fort lauderdale"),
            ),
            MarketSpec(
                "West Palm Beach",
                ("West Palm Beach", "Boca Raton", "Boynton Beach", "Delray Beach", "Palm Beach Gardens", "Jupiter", "Wellington", "Lake Worth Beach", "Fort Lauderdale"),
                metro_division_titles=("West Palm Beach-Boca Raton-Delray Beach, FL", "Fort Lauderdale-Pompano Beach-Sunrise, FL"),
                aliases=("palm beach county", "wpb metro"),
            ),
            MarketSpec("Tampa", ("Tampa", "St. Petersburg", "Clearwater", "Brandon", "Riverview", "Largo", "Pinellas Park", "Plant City"), cbsa_titles=("Tampa-St. Petersburg-Clearwater, FL",), aliases=("tampa bay",)),
            MarketSpec("Orlando", ("Orlando", "Kissimmee", "Sanford", "Winter Park", "Altamonte Springs", "Apopka", "Lake Mary", "Oviedo"), cbsa_titles=("Orlando-Kissimmee-Sanford, FL",)),
            MarketSpec("Jacksonville", ("Jacksonville", "St. Augustine", "Orange Park", "Atlantic Beach", "Ponte Vedra Beach", "Fleming Island", "Middleburg", "Fernandina Beach"), cbsa_titles=("Jacksonville, FL",)),
            MarketSpec("Fort Myers", ("Fort Myers", "Cape Coral", "Bonita Springs", "Lehigh Acres", "Estero", "North Fort Myers", "Sanibel", "Naples"), cbsa_titles=("Cape Coral-Fort Myers, FL",), aliases=("southwest florida",)),
            MarketSpec("Treasure Coast", ("Port St. Lucie", "Stuart", "Fort Pierce", "Vero Beach", "Palm City", "Jensen Beach", "Sebastian", "Hobe Sound"), cbsa_titles=("Port St. Lucie, FL", "Sebastian-Vero Beach-West Vero Corridor, FL"), aliases=("treasure coast region",)),
        ),
    ),
    StateSpec(
        "TX",
        "Dallas-Fort Worth",
        (
            MarketSpec("Dallas-Fort Worth", ("Dallas", "Fort Worth", "Arlington", "Plano", "Irving", "Frisco", "Denton", "McKinney"), cbsa_titles=("Dallas-Fort Worth-Arlington, TX",), aliases=("dfw", "dallas-fort worth-arlington")),
            MarketSpec("Houston", ("Houston", "The Woodlands", "Sugar Land", "Pasadena", "Pearland", "Conroe", "Katy", "Baytown"), cbsa_titles=("Houston-Pasadena-The Woodlands, TX",)),
            MarketSpec("Austin", ("Austin", "Round Rock", "Georgetown", "Cedar Park", "Pflugerville", "San Marcos", "Leander", "Kyle"), cbsa_titles=("Austin-Round Rock-San Marcos, TX",)),
            MarketSpec("San Antonio", ("San Antonio", "New Braunfels", "Schertz", "Converse", "Seguin", "Cibolo", "Universal City", "Boerne"), cbsa_titles=("San Antonio-New Braunfels, TX",)),
        ),
    ),
    StateSpec(
        "NC",
        "Charlotte",
        (
            MarketSpec("Charlotte", ("Charlotte", "Concord", "Gastonia", "Huntersville", "Matthews", "Mooresville", "Rock Hill, SC", "Monroe"), cbsa_titles=("Charlotte-Concord-Gastonia, NC-SC",)),
            MarketSpec("Raleigh-Durham", ("Raleigh", "Durham", "Cary", "Chapel Hill", "Apex", "Morrisville", "Wake Forest", "Research Triangle Park"), cbsa_titles=("Raleigh-Cary, NC", "Durham-Chapel Hill, NC"), aliases=("research triangle", "triangle area")),
            MarketSpec("Greensboro", ("Greensboro", "High Point", "Burlington", "Asheboro", "Reidsville", "Kernersville", "Thomasville", "Jamestown"), cbsa_titles=("Greensboro-High Point, NC",), aliases=("piedmont triad",)),
            MarketSpec("Winston-Salem", ("Winston-Salem", "Kernersville", "Clemmons", "Lewisville", "Mocksville", "Lexington", "Thomasville", "High Point"), cbsa_titles=("Winston-Salem, NC",), aliases=("piedmont triad",)),
        ),
    ),
    StateSpec(
        "VA",
        "Northern Virginia",
        (
            MarketSpec("Northern Virginia", ("Arlington", "Alexandria", "Fairfax", "Reston", "Tysons", "Manassas", "Leesburg", "Woodbridge"), cbsa_titles=("Washington-Arlington-Alexandria, DC-VA-MD-WV",), aliases=("nova", "northern va", "washington dc metro virginia")),
            MarketSpec("Richmond", ("Richmond", "Henrico", "Glen Allen", "Chesterfield", "Midlothian", "Petersburg", "Mechanicsville", "Short Pump"), cbsa_titles=("Richmond, VA",)),
            MarketSpec("Virginia Beach", ("Virginia Beach", "Chesapeake", "Norfolk", "Portsmouth", "Suffolk", "Hampton", "Newport News", "Williamsburg"), cbsa_titles=("Virginia Beach-Chesapeake-Norfolk, VA-NC",), aliases=("hampton roads",)),
            MarketSpec("Norfolk", ("Norfolk", "Virginia Beach", "Chesapeake", "Portsmouth", "Suffolk", "Hampton", "Newport News", "Williamsburg"), cbsa_titles=("Virginia Beach-Chesapeake-Norfolk, VA-NC",), aliases=("hampton roads", "norfolk-virginia beach")),
            MarketSpec("Manassas", ("Manassas", "Manassas Park", "Centreville", "Gainesville", "Haymarket", "Bristow", "Woodbridge", "Fairfax"), cbsa_titles=("Washington-Arlington-Alexandria, DC-VA-MD-WV",)),
        ),
    ),
    StateSpec(
        "OH",
        "Columbus",
        (
            MarketSpec("Columbus", ("Columbus", "Dublin", "Westerville", "Grove City", "Hilliard", "Gahanna", "Reynoldsburg", "New Albany"), cbsa_titles=("Columbus, OH",)),
            MarketSpec("Cincinnati", ("Cincinnati", "Hamilton", "Middletown", "Mason", "Fairfield", "Blue Ash", "West Chester", "Florence, KY"), cbsa_titles=("Cincinnati, OH-KY-IN",)),
            MarketSpec("Cleveland", ("Cleveland", "Akron", "Parma", "Lakewood", "Elyria", "Mentor", "Solon", "Beachwood"), cbsa_titles=("Cleveland, OH",)),
            MarketSpec("Dayton", ("Dayton", "Kettering", "Beavercreek", "Miamisburg", "Fairborn", "Huber Heights", "Troy", "Springfield"), cbsa_titles=("Dayton-Kettering-Beavercreek, OH",)),
            MarketSpec("Toledo", ("Toledo", "Maumee", "Perrysburg", "Sylvania", "Oregon", "Bowling Green", "Waterville", "Findlay"), cbsa_titles=("Toledo, OH",)),
        ),
    ),
    StateSpec(
        "TN",
        "Nashville",
        (
            MarketSpec("Nashville", ("Nashville", "Franklin", "Murfreesboro", "Hendersonville", "Smyrna", "Brentwood", "Gallatin", "Lebanon"), cbsa_titles=("Nashville-Davidson--Murfreesboro--Franklin, TN",)),
            MarketSpec("Chattanooga", ("Chattanooga", "Cleveland", "Ooltewah", "Hixson", "East Ridge", "Soddy-Daisy", "Red Bank", "Collegedale"), cbsa_titles=("Chattanooga, TN-GA",)),
            MarketSpec("Knoxville", ("Knoxville", "Maryville", "Oak Ridge", "Alcoa", "Farragut", "Sevierville", "Clinton", "Lenoir City"), cbsa_titles=("Knoxville, TN",)),
            MarketSpec("Memphis", ("Memphis", "Bartlett", "Germantown", "Collierville", "Cordova", "Arlington", "Millington", "Lakeland"), cbsa_titles=("Memphis, TN-MS-AR",)),
        ),
    ),
    StateSpec(
        "SC",
        "Charleston",
        (
            MarketSpec("Charleston", ("Charleston", "North Charleston", "Mount Pleasant", "Summerville", "Goose Creek", "Hanahan", "Ladson", "Moncks Corner"), cbsa_titles=("Charleston-North Charleston, SC",)),
            MarketSpec("Greenville", ("Greenville", "Greer", "Mauldin", "Simpsonville", "Taylors", "Easley", "Travelers Rest", "Anderson"), cbsa_titles=("Greenville-Anderson-Greer, SC",), aliases=("upstate south carolina",)),
            MarketSpec("Columbia", ("Columbia", "Lexington", "West Columbia", "Cayce", "Irmo", "Forest Acres", "Blythewood", "Sumter"), cbsa_titles=("Columbia, SC",)),
            MarketSpec("Spartanburg", ("Spartanburg", "Greer", "Boiling Springs", "Duncan", "Inman", "Gaffney", "Union", "Woodruff"), cbsa_titles=("Spartanburg, SC",)),
        ),
    ),
    StateSpec(
        "AZ",
        "Phoenix",
        (
            MarketSpec("Phoenix", ("Phoenix", "Scottsdale", "Mesa", "Chandler", "Glendale", "Tempe", "Peoria", "Gilbert"), cbsa_titles=("Phoenix-Mesa-Chandler, AZ",)),
            MarketSpec("Scottsdale", ("Scottsdale", "Phoenix", "Tempe", "Mesa", "Paradise Valley", "Fountain Hills", "Cave Creek", "Carefree"), cbsa_titles=("Phoenix-Mesa-Chandler, AZ",)),
            MarketSpec("Mesa", ("Mesa", "Gilbert", "Chandler", "Tempe", "Apache Junction", "Queen Creek", "Scottsdale", "Phoenix"), cbsa_titles=("Phoenix-Mesa-Chandler, AZ",)),
            MarketSpec("Chandler", ("Chandler", "Gilbert", "Mesa", "Tempe", "Phoenix", "Scottsdale", "Queen Creek", "Ahwatukee"), cbsa_titles=("Phoenix-Mesa-Chandler, AZ",)),
        ),
    ),
    StateSpec(
        "PA",
        "Philadelphia",
        (
            MarketSpec("Philadelphia", ("Philadelphia", "King of Prussia", "Norristown", "Media", "Bensalem", "West Chester", "Doylestown", "Chester"), cbsa_titles=("Philadelphia-Camden-Wilmington, PA-NJ-DE-MD",)),
            MarketSpec("Pittsburgh", ("Pittsburgh", "Monroeville", "Cranberry Township", "Bethel Park", "Mount Lebanon", "Greensburg", "Washington", "Butler"), cbsa_titles=("Pittsburgh, PA",)),
            MarketSpec("Harrisburg", ("Harrisburg", "Carlisle", "Mechanicsburg", "Camp Hill", "Middletown", "Hershey", "Lebanon", "York"), cbsa_titles=("Harrisburg-Carlisle, PA",)),
            MarketSpec("Allentown", ("Allentown", "Bethlehem", "Easton", "Whitehall", "Emmaus", "Nazareth", "Quakertown", "Stroudsburg"), cbsa_titles=("Allentown-Bethlehem-Easton, PA-NJ",), aliases=("lehigh valley",)),
        ),
    ),
    StateSpec(
        "IL",
        "Chicago",
        (
            MarketSpec("Chicago", ("Chicago", "Aurora", "Naperville", "Joliet", "Elgin", "Schaumburg", "Evanston", "Oak Brook"), cbsa_titles=("Chicago-Naperville-Elgin, IL-IN",)),
            MarketSpec("Rockford", ("Rockford", "Belvidere", "Machesney Park", "Loves Park", "Roscoe", "Freeport", "Byron", "Winnebago"), cbsa_titles=("Rockford, IL",)),
            MarketSpec("Peoria", ("Peoria", "East Peoria", "Pekin", "Morton", "Washington", "Dunlap", "Bartonville", "Normal"), cbsa_titles=("Peoria, IL",)),
        ),
    ),
    StateSpec(
        "IN",
        "Indianapolis",
        (
            MarketSpec("Indianapolis", ("Indianapolis", "Carmel", "Fishers", "Noblesville", "Greenwood", "Plainfield", "Avon", "Zionsville"), cbsa_titles=("Indianapolis-Carmel-Greenwood, IN",)),
            MarketSpec("Fort Wayne", ("Fort Wayne", "New Haven", "Auburn", "Huntington", "Decatur", "Columbia City", "Bluffton", "Warsaw"), cbsa_titles=("Fort Wayne, IN",)),
            MarketSpec("South Bend", ("South Bend", "Mishawaka", "Elkhart", "Goshen", "Niles, MI", "Granger", "Plymouth", "La Porte"), cbsa_titles=("South Bend-Mishawaka, IN-MI",)),
            MarketSpec("Evansville", ("Evansville", "Newburgh", "Boonville", "Princeton", "Mount Vernon", "Jasper", "Henderson, KY", "Vincennes"), cbsa_titles=("Evansville, IN",)),
        ),
    ),
    StateSpec(
        "MI",
        "Detroit",
        (
            MarketSpec("Detroit", ("Detroit", "Warren", "Troy", "Dearborn", "Livonia", "Southfield", "Novi"), cbsa_titles=("Detroit-Warren-Dearborn, MI",)),
            MarketSpec("Grand Rapids", ("Grand Rapids", "Wyoming", "Kentwood", "Holland", "Muskegon", "Walker", "Hudsonville", "Rockford"), cbsa_titles=("Grand Rapids-Wyoming-Kentwood, MI",)),
            MarketSpec("Ann Arbor", ("Ann Arbor", "Ypsilanti", "Saline", "Chelsea", "Dexter", "Pittsfield Township", "Canton", "Brighton"), cbsa_titles=("Ann Arbor, MI",)),
            MarketSpec("Lansing", ("Lansing", "East Lansing", "Okemos", "Haslett", "Holt", "Grand Ledge", "Mason", "Charlotte"), cbsa_titles=("Lansing-East Lansing, MI",)),
        ),
    ),
    StateSpec(
        "CO",
        "Denver",
        (
            MarketSpec("Denver", ("Denver", "Aurora", "Lakewood", "Centennial", "Broomfield", "Littleton", "Englewood"), cbsa_titles=("Denver-Aurora-Centennial, CO",)),
            MarketSpec("Colorado Springs", ("Colorado Springs", "Pueblo", "Fountain", "Monument", "Manitou Springs", "Woodland Park", "Security-Widefield", "Castle Rock"), cbsa_titles=("Colorado Springs, CO",)),
            MarketSpec("Boulder", ("Boulder", "Longmont", "Lafayette", "Louisville", "Broomfield", "Superior", "Erie", "Gunbarrel"), cbsa_titles=("Boulder, CO",)),
            MarketSpec("Fort Collins", ("Fort Collins", "Loveland", "Greeley", "Windsor", "Timnath", "Wellington", "Johnstown", "Berthoud"), cbsa_titles=("Fort Collins-Loveland, CO",)),
        ),
    ),
    StateSpec(
        "NJ",
        "Northern New Jersey",
        (
            MarketSpec("Newark", ("Newark", "Elizabeth", "East Orange", "Bloomfield", "Irvington", "Union", "Orange", "Montclair"), metro_division_titles=("Newark, NJ",)),
            MarketSpec("Jersey City", ("Jersey City", "Hoboken", "Bayonne", "Union City", "North Bergen", "Secaucus", "Weehawken", "Kearny"), metro_division_titles=("New York-Jersey City-White Plains, NY-NJ",)),
            MarketSpec("Princeton", ("Princeton", "Trenton", "Hamilton", "Lawrence Township", "West Windsor", "Plainsboro", "Hopewell", "Ewing"), cbsa_titles=("Trenton-Princeton, NJ",)),
            MarketSpec("Morristown", ("Morristown", "Parsippany", "Madison", "Florham Park", "Morris Plains", "Dover", "Denville", "Chatham"), metro_division_titles=("Newark, NJ",)),
            MarketSpec("Northern New Jersey", ("Newark", "Jersey City", "Paterson", "Hackensack", "Elizabeth", "Clifton", "Paramus", "Morristown"), metro_division_titles=("Newark, NJ", "New York-Jersey City-White Plains, NY-NJ"), aliases=("north jersey", "northern nj")),
        ),
    ),
)


def ensure_sources() -> None:
    CENSUS_DIR.mkdir(parents=True, exist_ok=True)
    for key, url in SOURCE_URLS.items():
        target = LOCAL_FILES[key]
        if target.exists() and target.stat().st_size:
            continue
        print(f"Downloading {url}")
        with urllib.request.urlopen(url, timeout=240) as response:
            target.write_bytes(response.read())


def read_xlsx_rows(path: Path) -> list[dict[str, str]]:
    ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with ZipFile(path) as zf:
        shared: list[str] = []
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        for item in root.findall("a:si", ns):
            shared.append("".join(t.text or "" for t in item.findall(".//a:t", ns)))

        sheet = ET.fromstring(zf.read("xl/worksheets/sheet1.xml"))
        headers: list[str] | None = None
        out: list[dict[str, str]] = []
        for row in sheet.findall(".//a:row", ns):
            values: list[str] = []
            for cell in row.findall("a:c", ns):
                value = cell.find("a:v", ns)
                text = value.text if value is not None else ""
                if cell.get("t") == "s" and text:
                    text = shared[int(text)]
                values.append(text)
            if values and values[0] == "CBSA Code":
                headers = values
                continue
            if headers and len(values) >= len(headers):
                out.append(dict(zip(headers, values)))
        return out


def parse_acs_geography(
    path: Path,
) -> tuple[
    dict[str, str],
    dict[tuple[str, str], list[str]],
    dict[tuple[str, str], list[str]],
    dict[tuple[str, str], list[str]],
]:
    state_code_to_abbr: dict[str, str] = {}
    county_code_to_name: dict[tuple[str, str], str] = {}
    places_to_counties: dict[tuple[str, str], set[str]] = {}
    subdivisions_to_counties: dict[tuple[str, str], set[str]] = {}
    county_equivalents: dict[tuple[str, str], set[str]] = {}

    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle, delimiter="|")
        headers = next(reader)
        idx = {name: i for i, name in enumerate(headers)}
        rows = list(reader)

    for row in rows:
        stusab = row[idx["STUSAB"]]
        state_code = row[idx["STATE"]]
        if stusab and state_code:
            state_code_to_abbr[state_code] = stusab
        if row[idx["SUMLEVEL"]] == "050":
            county_code_to_name[(state_code, row[idx["COUNTY"]])] = row[idx["NAME"]].split(",")[0]

    for row in rows:
        sumlevel = row[idx["SUMLEVEL"]]
        stusab = row[idx["STUSAB"]]
        state_code = row[idx["STATE"]]
        county_code = row[idx["COUNTY"]]
        if not stusab or not state_code or stusab not in STATE_NAMES:
            continue

        county_name = county_code_to_name.get((state_code, county_code))
        if sumlevel == "050" and county_code:
            name = row[idx["NAME"]].split(",")[0]
            if name.endswith(" city"):
                for key in locality_keys(name, stusab):
                    county_equivalents.setdefault(key, set()).add(
                        county_token(name, stusab)
                    )
            continue

        if not county_name:
            continue

        name = row[idx["NAME"]]
        if sumlevel == "155":
            match = re.search(
                r"^.*?(?:\s+\(part\))?,\s*(.*?),\s*[^,]+$",
                name,
            )
            if match:
                for key in locality_keys(match.group(1), stusab):
                    places_to_counties.setdefault(key, set()).add(
                        county_token(county_name, stusab)
                    )
        elif sumlevel == "060":
            for key in locality_keys(name.split(",")[0], stusab):
                subdivisions_to_counties.setdefault(key, set()).add(
                    county_token(county_name, stusab)
                )

    return (
        state_code_to_abbr,
        {key: sorted(value) for key, value in places_to_counties.items()},
        {key: sorted(value) for key, value in county_equivalents.items()},
        {key: sorted(value) for key, value in subdivisions_to_counties.items()},
    )


def parse_cbsa_rows(rows: list[dict[str, str]]) -> tuple[dict[str, list[dict[str, str]]], dict[str, list[dict[str, str]]]]:
    by_cbsa: dict[str, list[dict[str, str]]] = {}
    by_division: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_cbsa.setdefault(row["CBSA Title"], []).append(row)
        division = row.get("Metropolitan Division Title", "")
        if division:
            by_division.setdefault(division, []).append(row)
    return by_cbsa, by_division


def source_counties(
    market: MarketSpec,
    by_cbsa: dict[str, list[dict[str, str]]],
    by_division: dict[str, list[dict[str, str]]],
) -> tuple[list[str], list[str], list[str]]:
    rows: list[dict[str, str]] = []
    source_names: list[str] = []
    for title in market.cbsa_titles:
        selected = by_cbsa.get(title)
        if not selected:
            raise ValueError(f"CBSA title not found: {title}")
        rows.extend(selected)
        source_names.append(title)
    for title in market.metro_division_titles:
        selected = by_division.get(title)
        if not selected:
            raise ValueError(f"Metropolitan Division title not found: {title}")
        rows.extend(selected)
        source_names.append(title)

    counties = sorted(
        {
            county_token(row["County/County Equivalent"], STATE_ABBRS[row["State Name"]])
            for row in rows
        }
    )
    row_ids = sorted(
        {
            f"{row['CBSA Code']}:{row.get('Metropolitan Division Code', '')}:{row['FIPS State Code']}{row['FIPS County Code']}"
            for row in rows
        }
    )
    return counties, source_names, row_ids


def resolve_hub(
    raw_hub: str,
    market_state: str,
    authoritative_counties: set[str],
    places_to_counties: dict[tuple[str, str], list[str]],
    county_equivalents: dict[tuple[str, str], list[str]],
    subdivisions_to_counties: dict[tuple[str, str], list[str]],
) -> dict[str, object]:
    hub_name, hub_state = parse_city_state(raw_hub, market_state)
    keys = [
        (clean_locality_name(hub_name), hub_state),
        (strip_locality_suffix(hub_name), hub_state),
    ]
    for alias in LOCALITY_ALIASES.get((clean_locality_name(hub_name), hub_state), ()):
        keys.extend(
            [
                (clean_locality_name(alias), hub_state),
                (strip_locality_suffix(alias), hub_state),
            ]
        )
    source_layer = "place/county relationship"
    counties = next((places_to_counties[key] for key in keys if key in places_to_counties), [])
    if not counties:
        source_layer = "county-equivalent"
        counties = next((county_equivalents[key] for key in keys if key in county_equivalents), [])
    if not counties:
        source_layer = "county-subdivision relationship"
        counties = next((subdivisions_to_counties[key] for key in keys if key in subdivisions_to_counties), [])
    output_hub = display_hub(hub_name, hub_state, market_state)
    if not counties:
        direct_county = next(
            (
                county
                for county in authoritative_counties
                if norm(county.removesuffix(f", {hub_state}")) == clean_locality_name(hub_name)
                and county.endswith(f", {hub_state}")
            ),
            None,
        )
        if direct_county:
            return {
                "rawHub": raw_hub,
                "hub": output_hub,
                "stateAbbr": hub_state,
                "included": True,
                "counties": [direct_county],
                "excludedResolvedCounties": [],
                "reason": None,
                "source": "OMB/Census 2023 CBSA delineation direct county-equivalent match",
            }
        return {
            "rawHub": raw_hub,
            "hub": output_hub,
            "stateAbbr": hub_state,
            "included": False,
            "counties": [],
            "reason": "No Census ACS 5-year place/county, county-equivalent, or county-subdivision relationship record found.",
            "source": "Census ACS 2023 5-year geography header",
        }

    in_scope = [county for county in counties if county in authoritative_counties]
    outside = [county for county in counties if county not in authoritative_counties]
    if not in_scope:
        return {
            "rawHub": raw_hub,
            "hub": output_hub,
            "stateAbbr": hub_state,
            "included": False,
            "counties": counties,
            "reason": f"Resolved county-equivalent(s) outside selected OMB/Census metro county set: {', '.join(outside)}.",
            "source": "Census ACS 2023 5-year geography header + OMB/Census 2023 CBSA delineation",
        }

    return {
        "rawHub": raw_hub,
        "hub": output_hub,
        "stateAbbr": hub_state,
        "included": True,
        "counties": in_scope,
        "excludedResolvedCounties": outside,
        "reason": None,
        "source": f"Census ACS 2023 5-year {source_layer} + OMB/Census 2023 CBSA delineation",
    }


def market_aliases(market: MarketSpec) -> list[str]:
    return sorted(
        {
            f"{market.name} metropolitan area".lower(),
            f"greater {market.name} area".lower(),
            f"{market.name} metro".lower(),
            *(alias.lower() for alias in market.aliases),
        }
    )


def make_city_county_map(included_hubs: list[dict[str, object]]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    for hub in included_hubs:
        output = str(hub["hub"])
        city, state = parse_city_state(output, str(hub["stateAbbr"]))
        counties = list(hub["counties"])
        mapping[norm(city)] = counties
        mapping[norm(output)] = counties
        mapping[strip_locality_suffix(city)] = counties
    return dict(sorted(mapping.items()))


def generate() -> tuple[list[dict[str, object]], dict[str, object]]:
    ensure_sources()
    cbsa_rows = read_xlsx_rows(LOCAL_FILES["cbsaWorkbook"])
    by_cbsa, by_division = parse_cbsa_rows(cbsa_rows)
    _, places_to_counties, county_equivalents, subdivisions_to_counties = parse_acs_geography(
        LOCAL_FILES["acsGeography"]
    )

    states: list[dict[str, object]] = []
    coverage_states: list[dict[str, object]] = []

    for state in SPECS:
        markets: list[dict[str, object]] = []
        coverage_markets: list[dict[str, object]] = []
        for market in state.markets:
            counties, source_names, source_row_ids = source_counties(market, by_cbsa, by_division)
            authoritative = set(counties)
            hub_resolutions = [
                resolve_hub(
                    hub,
                    state.state_abbr,
                    authoritative,
                    places_to_counties,
                    county_equivalents,
                    subdivisions_to_counties,
                )
                for hub in market.hubs
            ]
            included = [hub for hub in hub_resolutions if hub["included"]]
            scrape_hubs = [str(hub["hub"]) for hub in included[:8]]
            city_county_map = make_city_county_map(included)
            independent = sorted(
                {
                    str(hub["hub"])
                    for hub in included
                    if (strip_locality_suffix(parse_city_state(str(hub["hub"]), str(hub["stateAbbr"]))[0]), str(hub["stateAbbr"]))
                    in county_equivalents
                }
            )

            markets.append(
                {
                    "marketName": market.name,
                    "scrapeHubs": scrape_hubs,
                    "aliases": market_aliases(market),
                    "focusCounties": counties,
                    "cityCountyMap": city_county_map,
                    **({"independentCities": independent} if independent else {}),
                    "sourceNames": source_names,
                }
            )
            coverage_markets.append(
                {
                    "marketName": market.name,
                    "sourceNames": source_names,
                    "sourceRowIds": source_row_ids,
                    "focusCounties": counties,
                    "hubResolutions": hub_resolutions,
                    "excludedHubs": [hub for hub in hub_resolutions if not hub["included"]],
                }
            )

        states.append(
            {
                "stateName": state.state_name,
                "stateAbbr": state.state_abbr,
                "defaultMarket": state.default_market,
                "sourceBasis": [
                    SOURCE_URLS["cbsaWorkbook"],
                    SOURCE_URLS["acsGeography"],
                    "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state.",
                ],
                "markets": markets,
            }
        )
        coverage_states.append(
            {
                "stateName": state.state_name,
                "stateAbbr": state.state_abbr,
                "defaultMarket": state.default_market,
                "markets": coverage_markets,
            }
        )

    coverage = {
        "generatedFrom": SOURCE_URLS,
        "policy": [
            "Full OMB/Census CBSA or Metropolitan Division county sets are used, including cross-state county-equivalents.",
            "Hub city county mappings are included only when Census ACS 2023 5-year geography rows resolve the place/county-equivalent and every resolved county is in the selected metro county set.",
            "Virginia independent cities are treated as Census county-equivalents.",
            "Unsupported hubs are excluded from scrape hubs and listed in this coverage report.",
            "Runtime remains one active market; market switching materializes focus cities, focus counties, metro cities, and aliases into existing settings fields.",
        ],
        "states": coverage_states,
    }
    return states, coverage


def ts_literal(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False)


def write_seed(states: list[dict[str, object]]) -> None:
    SEED_JSON.write_text(json.dumps(states, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    content = f"""import type {{ StateGeoConfig, StateGeoMetroPreset }} from "@/lib/state-geo-config";

export type ReviewableMarketGeo = {{
  marketName: string;
  scrapeHubs: string[];
  aliases: string[];
  focusCounties: string[];
  cityCountyMap: Record<string, string[]>;
  independentCities?: string[];
  sourceNames: string[];
}};

export type ReviewableStateGeoSeed = {{
  stateName: string;
  stateAbbr: string;
  defaultMarket: string;
  sourceBasis: string[];
  markets: ReviewableMarketGeo[];
}};

function norm(value: string): string {{
  return value.trim().toLowerCase().replace(/\\s+/g, " ");
}}

function unique(values: string[]): string[] {{
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}}

export const REVIEWABLE_STATE_GEO_EXPANSION: ReviewableStateGeoSeed[] = {ts_literal(states)};

export function toStateGeoConfig(
  seed: ReviewableStateGeoSeed,
  marketName = seed.defaultMarket,
): StateGeoConfig {{
  const selected =
    seed.markets.find((m) => norm(m.marketName) === norm(marketName)) ??
    seed.markets[0];
  const cities = unique(seed.markets.flatMap((m) => m.scrapeHubs));
  const counties = unique(seed.markets.flatMap((m) => m.focusCounties));
  const cityCountyMap = Object.fromEntries(
    seed.markets.flatMap((m) => Object.entries(m.cityCountyMap)),
  );
  const metroPresets = Object.fromEntries(
    seed.markets.map((m): [string, StateGeoMetroPreset] => [
      norm(m.marketName),
      {{
        marketName: m.marketName,
        metroCities: m.scrapeHubs,
        metroAliases: m.aliases,
        focusCounties: m.focusCounties,
      }},
    ]),
  );

  return {{
    stateName: seed.stateName,
    stateAbbr: seed.stateAbbr,
    cities,
    counties,
    defaultFocusCities: [selected.scrapeHubs[0]].filter(Boolean),
    defaultFocusCounties: selected.focusCounties,
    defaultMetroCities: selected.scrapeHubs,
    defaultMetroAliases: selected.aliases,
    cityCountyMap,
    metroPresets,
  }};
}}

export function reviewNotes(): Array<{{
  stateName: string;
  marketName: string;
  notes: string[];
}}> {{
  return [];
}}
"""
    SEED_TS.write_text(content, encoding="utf-8")


def write_coverage(coverage: dict[str, object]) -> None:
    COVERAGE_JSON.write_text(json.dumps(coverage, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = [
        "# Expanded State Geo Coverage",
        "",
        "Generated from:",
        f"- OMB/Census CBSA delineation: {SOURCE_URLS['cbsaWorkbook']}",
        f"- Census ACS 2023 5-year geography header: {SOURCE_URLS['acsGeography']}",
        "",
        "Policy: full OMB/Census metro county sets are used, including cross-state counties. Hubs that cannot be resolved to Census place/county-equivalent rows inside the selected metro are excluded and listed below.",
        "",
    ]
    for state in coverage["states"]:  # type: ignore[index]
        lines.append(f"## {state['stateName']}")
        for market in state["markets"]:
            lines.append(f"### {market['marketName']}")
            lines.append(f"- Sources: {', '.join(market['sourceNames'])}")
            lines.append(f"- Focus counties: {', '.join(market['focusCounties'])}")
            excluded = market["excludedHubs"]
            if excluded:
                lines.append("- Excluded hubs:")
                for hub in excluded:
                    lines.append(f"  - {hub['rawHub']}: {hub['reason']}")
            else:
                lines.append("- Excluded hubs: none")
            lines.append("")
    COVERAGE_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    states, coverage = generate()
    write_seed(states)
    write_coverage(coverage)
    print(f"Wrote {SEED_TS.relative_to(ROOT)}")
    print(f"Wrote {SEED_JSON.relative_to(ROOT)}")
    print(f"Wrote {COVERAGE_JSON.relative_to(ROOT)}")
    print(f"Wrote {COVERAGE_MD.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
