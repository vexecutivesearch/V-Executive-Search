import type { StateGeoConfig, StateGeoMetroPreset } from "@/lib/state-geo-config";

export type ReviewableMarketGeo = {
  marketName: string;
  scrapeHubs: string[];
  aliases: string[];
  focusCounties: string[];
  cityCountyMap: Record<string, string[]>;
  independentCities?: string[];
  sourceNames: string[];
};

export type ReviewableStateGeoSeed = {
  stateName: string;
  stateAbbr: string;
  defaultMarket: string;
  sourceBasis: string[];
  markets: ReviewableMarketGeo[];
};

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export const REVIEWABLE_STATE_GEO_EXPANSION: ReviewableStateGeoSeed[] = [
  {
    "stateName": "Florida",
    "stateAbbr": "FL",
    "defaultMarket": "West Palm Beach",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Miami / Fort Lauderdale",
        "scrapeHubs": [
          "Miami",
          "Fort Lauderdale",
          "Hollywood",
          "Pembroke Pines",
          "Miramar",
          "Coral Springs",
          "Pompano Beach",
          "Hialeah"
        ],
        "aliases": [
          "greater miami / fort lauderdale area",
          "miami / fort lauderdale metro",
          "miami / fort lauderdale metropolitan area",
          "miami-fort lauderdale",
          "south florida"
        ],
        "focusCounties": [
          "Broward, FL",
          "Miami-Dade, FL"
        ],
        "cityCountyMap": {
          "coral springs": [
            "Broward, FL"
          ],
          "fort lauderdale": [
            "Broward, FL"
          ],
          "hialeah": [
            "Miami-Dade, FL"
          ],
          "hollywood": [
            "Broward, FL"
          ],
          "miami": [
            "Miami-Dade, FL"
          ],
          "miramar": [
            "Broward, FL"
          ],
          "pembroke pines": [
            "Broward, FL"
          ],
          "pompano beach": [
            "Broward, FL"
          ]
        },
        "sourceNames": [
          "Miami-Miami Beach-Kendall, FL",
          "Fort Lauderdale-Pompano Beach-Sunrise, FL"
        ]
      },
      {
        "marketName": "West Palm Beach",
        "scrapeHubs": [
          "West Palm Beach",
          "Boca Raton",
          "Boynton Beach",
          "Delray Beach",
          "Palm Beach Gardens",
          "Jupiter",
          "Wellington",
          "Lake Worth Beach"
        ],
        "aliases": [
          "greater west palm beach area",
          "palm beach county",
          "west palm beach metro",
          "west palm beach metropolitan area",
          "wpb metro"
        ],
        "focusCounties": [
          "Broward, FL",
          "Palm Beach, FL"
        ],
        "cityCountyMap": {
          "boca raton": [
            "Palm Beach, FL"
          ],
          "boynton beach": [
            "Palm Beach, FL"
          ],
          "delray beach": [
            "Palm Beach, FL"
          ],
          "fort lauderdale": [
            "Broward, FL"
          ],
          "jupiter": [
            "Palm Beach, FL"
          ],
          "lake worth beach": [
            "Palm Beach, FL"
          ],
          "palm beach gardens": [
            "Palm Beach, FL"
          ],
          "wellington": [
            "Palm Beach, FL"
          ],
          "west palm beach": [
            "Palm Beach, FL"
          ]
        },
        "sourceNames": [
          "West Palm Beach-Boca Raton-Delray Beach, FL",
          "Fort Lauderdale-Pompano Beach-Sunrise, FL"
        ]
      },
      {
        "marketName": "Tampa",
        "scrapeHubs": [
          "Tampa",
          "St. Petersburg",
          "Clearwater",
          "Brandon",
          "Riverview",
          "Largo",
          "Pinellas Park",
          "Plant City"
        ],
        "aliases": [
          "greater tampa area",
          "tampa bay",
          "tampa metro",
          "tampa metropolitan area"
        ],
        "focusCounties": [
          "Hernando, FL",
          "Hillsborough, FL",
          "Pasco, FL",
          "Pinellas, FL"
        ],
        "cityCountyMap": {
          "brandon": [
            "Hillsborough, FL"
          ],
          "clearwater": [
            "Pinellas, FL"
          ],
          "largo": [
            "Pinellas, FL"
          ],
          "pinellas park": [
            "Pinellas, FL"
          ],
          "plant": [
            "Hillsborough, FL"
          ],
          "plant city": [
            "Hillsborough, FL"
          ],
          "riverview": [
            "Hillsborough, FL"
          ],
          "st. petersburg": [
            "Pinellas, FL"
          ],
          "tampa": [
            "Hillsborough, FL"
          ]
        },
        "sourceNames": [
          "Tampa-St. Petersburg-Clearwater, FL"
        ]
      },
      {
        "marketName": "Orlando",
        "scrapeHubs": [
          "Orlando",
          "Kissimmee",
          "Sanford",
          "Winter Park",
          "Altamonte Springs",
          "Apopka",
          "Lake Mary",
          "Oviedo"
        ],
        "aliases": [
          "greater orlando area",
          "orlando metro",
          "orlando metropolitan area"
        ],
        "focusCounties": [
          "Lake, FL",
          "Orange, FL",
          "Osceola, FL",
          "Seminole, FL"
        ],
        "cityCountyMap": {
          "altamonte springs": [
            "Seminole, FL"
          ],
          "apopka": [
            "Orange, FL"
          ],
          "kissimmee": [
            "Osceola, FL"
          ],
          "lake mary": [
            "Seminole, FL"
          ],
          "orlando": [
            "Orange, FL"
          ],
          "oviedo": [
            "Seminole, FL"
          ],
          "sanford": [
            "Seminole, FL"
          ],
          "winter park": [
            "Orange, FL"
          ]
        },
        "sourceNames": [
          "Orlando-Kissimmee-Sanford, FL"
        ]
      },
      {
        "marketName": "Jacksonville",
        "scrapeHubs": [
          "Jacksonville",
          "St. Augustine",
          "Orange Park",
          "Atlantic Beach",
          "Fleming Island",
          "Middleburg",
          "Fernandina Beach"
        ],
        "aliases": [
          "greater jacksonville area",
          "jacksonville metro",
          "jacksonville metropolitan area"
        ],
        "focusCounties": [
          "Baker, FL",
          "Clay, FL",
          "Duval, FL",
          "Nassau, FL",
          "St. Johns, FL"
        ],
        "cityCountyMap": {
          "atlantic beach": [
            "Duval, FL"
          ],
          "fernandina beach": [
            "Nassau, FL"
          ],
          "fleming island": [
            "Clay, FL"
          ],
          "jacksonville": [
            "Duval, FL"
          ],
          "middleburg": [
            "Clay, FL"
          ],
          "orange park": [
            "Clay, FL"
          ],
          "st. augustine": [
            "St. Johns, FL"
          ]
        },
        "sourceNames": [
          "Jacksonville, FL"
        ]
      },
      {
        "marketName": "Fort Myers",
        "scrapeHubs": [
          "Fort Myers",
          "Cape Coral",
          "Bonita Springs",
          "Lehigh Acres",
          "Estero",
          "North Fort Myers",
          "Sanibel"
        ],
        "aliases": [
          "fort myers metro",
          "fort myers metropolitan area",
          "greater fort myers area",
          "southwest florida"
        ],
        "focusCounties": [
          "Lee, FL"
        ],
        "cityCountyMap": {
          "bonita springs": [
            "Lee, FL"
          ],
          "cape coral": [
            "Lee, FL"
          ],
          "estero": [
            "Lee, FL"
          ],
          "fort myers": [
            "Lee, FL"
          ],
          "lehigh acres": [
            "Lee, FL"
          ],
          "north fort myers": [
            "Lee, FL"
          ],
          "sanibel": [
            "Lee, FL"
          ]
        },
        "sourceNames": [
          "Cape Coral-Fort Myers, FL"
        ]
      },
      {
        "marketName": "Treasure Coast",
        "scrapeHubs": [
          "Port St. Lucie",
          "Stuart",
          "Fort Pierce",
          "Vero Beach",
          "Palm City",
          "Jensen Beach",
          "Sebastian",
          "Hobe Sound"
        ],
        "aliases": [
          "greater treasure coast area",
          "treasure coast metro",
          "treasure coast metropolitan area",
          "treasure coast region"
        ],
        "focusCounties": [
          "Indian River, FL",
          "Martin, FL",
          "St. Lucie, FL"
        ],
        "cityCountyMap": {
          "fort pierce": [
            "St. Lucie, FL"
          ],
          "hobe sound": [
            "Martin, FL"
          ],
          "jensen beach": [
            "Martin, FL"
          ],
          "palm": [
            "Martin, FL"
          ],
          "palm city": [
            "Martin, FL"
          ],
          "port st. lucie": [
            "St. Lucie, FL"
          ],
          "sebastian": [
            "Indian River, FL"
          ],
          "stuart": [
            "Martin, FL"
          ],
          "vero beach": [
            "Indian River, FL"
          ]
        },
        "sourceNames": [
          "Port St. Lucie, FL",
          "Sebastian-Vero Beach-West Vero Corridor, FL"
        ]
      }
    ]
  },
  {
    "stateName": "Texas",
    "stateAbbr": "TX",
    "defaultMarket": "Dallas-Fort Worth",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Dallas-Fort Worth",
        "scrapeHubs": [
          "Dallas",
          "Fort Worth",
          "Arlington",
          "Plano",
          "Irving",
          "Frisco",
          "Denton",
          "McKinney"
        ],
        "aliases": [
          "dallas-fort worth metro",
          "dallas-fort worth metropolitan area",
          "dallas-fort worth-arlington",
          "dfw",
          "greater dallas-fort worth area"
        ],
        "focusCounties": [
          "Collin, TX",
          "Dallas, TX",
          "Denton, TX",
          "Ellis, TX",
          "Hunt, TX",
          "Johnson, TX",
          "Kaufman, TX",
          "Parker, TX",
          "Rockwall, TX",
          "Tarrant, TX",
          "Wise, TX"
        ],
        "cityCountyMap": {
          "arlington": [
            "Tarrant, TX"
          ],
          "dallas": [
            "Collin, TX",
            "Dallas, TX",
            "Denton, TX",
            "Kaufman, TX",
            "Rockwall, TX"
          ],
          "denton": [
            "Denton, TX"
          ],
          "fort worth": [
            "Denton, TX",
            "Johnson, TX",
            "Parker, TX",
            "Tarrant, TX",
            "Wise, TX"
          ],
          "frisco": [
            "Collin, TX",
            "Denton, TX"
          ],
          "irving": [
            "Dallas, TX"
          ],
          "mckinney": [
            "Collin, TX"
          ],
          "plano": [
            "Collin, TX",
            "Denton, TX"
          ]
        },
        "sourceNames": [
          "Dallas-Fort Worth-Arlington, TX"
        ]
      },
      {
        "marketName": "Houston",
        "scrapeHubs": [
          "Houston",
          "The Woodlands",
          "Sugar Land",
          "Pasadena",
          "Pearland",
          "Conroe",
          "Katy",
          "Baytown"
        ],
        "aliases": [
          "greater houston area",
          "houston metro",
          "houston metropolitan area"
        ],
        "focusCounties": [
          "Austin, TX",
          "Brazoria, TX",
          "Chambers, TX",
          "Fort Bend, TX",
          "Galveston, TX",
          "Harris, TX",
          "Liberty, TX",
          "Montgomery, TX",
          "San Jacinto, TX",
          "Waller, TX"
        ],
        "cityCountyMap": {
          "baytown": [
            "Chambers, TX",
            "Harris, TX"
          ],
          "conroe": [
            "Montgomery, TX"
          ],
          "houston": [
            "Fort Bend, TX",
            "Harris, TX",
            "Montgomery, TX",
            "Waller, TX"
          ],
          "katy": [
            "Fort Bend, TX",
            "Harris, TX",
            "Waller, TX"
          ],
          "pasadena": [
            "Harris, TX"
          ],
          "pearland": [
            "Brazoria, TX",
            "Fort Bend, TX",
            "Harris, TX"
          ],
          "sugar land": [
            "Fort Bend, TX"
          ],
          "the woodlands": [
            "Harris, TX",
            "Montgomery, TX"
          ]
        },
        "sourceNames": [
          "Houston-Pasadena-The Woodlands, TX"
        ]
      },
      {
        "marketName": "Austin",
        "scrapeHubs": [
          "Austin",
          "Round Rock",
          "Georgetown",
          "Cedar Park",
          "Pflugerville",
          "San Marcos",
          "Leander",
          "Kyle"
        ],
        "aliases": [
          "austin metro",
          "austin metropolitan area",
          "greater austin area"
        ],
        "focusCounties": [
          "Bastrop, TX",
          "Caldwell, TX",
          "Hays, TX",
          "Travis, TX",
          "Williamson, TX"
        ],
        "cityCountyMap": {
          "austin": [
            "Bastrop, TX",
            "Hays, TX",
            "Travis, TX",
            "Williamson, TX"
          ],
          "cedar park": [
            "Travis, TX",
            "Williamson, TX"
          ],
          "georgetown": [
            "Williamson, TX"
          ],
          "kyle": [
            "Hays, TX"
          ],
          "leander": [
            "Travis, TX",
            "Williamson, TX"
          ],
          "pflugerville": [
            "Travis, TX",
            "Williamson, TX"
          ],
          "round rock": [
            "Travis, TX",
            "Williamson, TX"
          ],
          "san marcos": [
            "Caldwell, TX",
            "Hays, TX"
          ]
        },
        "sourceNames": [
          "Austin-Round Rock-San Marcos, TX"
        ]
      },
      {
        "marketName": "San Antonio",
        "scrapeHubs": [
          "San Antonio",
          "New Braunfels",
          "Schertz",
          "Converse",
          "Seguin",
          "Cibolo",
          "Universal City",
          "Boerne"
        ],
        "aliases": [
          "greater san antonio area",
          "san antonio metro",
          "san antonio metropolitan area"
        ],
        "focusCounties": [
          "Atascosa, TX",
          "Bandera, TX",
          "Bexar, TX",
          "Comal, TX",
          "Guadalupe, TX",
          "Kendall, TX",
          "Medina, TX",
          "Wilson, TX"
        ],
        "cityCountyMap": {
          "boerne": [
            "Kendall, TX"
          ],
          "cibolo": [
            "Bexar, TX",
            "Guadalupe, TX"
          ],
          "converse": [
            "Bexar, TX"
          ],
          "new braunfels": [
            "Comal, TX",
            "Guadalupe, TX"
          ],
          "san antonio": [
            "Bexar, TX",
            "Comal, TX",
            "Medina, TX"
          ],
          "schertz": [
            "Bexar, TX",
            "Comal, TX",
            "Guadalupe, TX"
          ],
          "seguin": [
            "Guadalupe, TX"
          ],
          "universal": [
            "Bexar, TX",
            "Guadalupe, TX"
          ],
          "universal city": [
            "Bexar, TX",
            "Guadalupe, TX"
          ]
        },
        "sourceNames": [
          "San Antonio-New Braunfels, TX"
        ]
      }
    ]
  },
  {
    "stateName": "North Carolina",
    "stateAbbr": "NC",
    "defaultMarket": "Charlotte",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Charlotte",
        "scrapeHubs": [
          "Charlotte",
          "Concord",
          "Gastonia",
          "Huntersville",
          "Matthews",
          "Mooresville",
          "Rock Hill, SC",
          "Monroe"
        ],
        "aliases": [
          "charlotte metro",
          "charlotte metropolitan area",
          "greater charlotte area"
        ],
        "focusCounties": [
          "Anson, NC",
          "Cabarrus, NC",
          "Chester, SC",
          "Gaston, NC",
          "Iredell, NC",
          "Lancaster, SC",
          "Lincoln, NC",
          "Mecklenburg, NC",
          "Rowan, NC",
          "Union, NC",
          "York, SC"
        ],
        "cityCountyMap": {
          "charlotte": [
            "Mecklenburg, NC"
          ],
          "concord": [
            "Cabarrus, NC",
            "Mecklenburg, NC"
          ],
          "gastonia": [
            "Gaston, NC"
          ],
          "huntersville": [
            "Mecklenburg, NC"
          ],
          "matthews": [
            "Mecklenburg, NC"
          ],
          "monroe": [
            "Union, NC"
          ],
          "mooresville": [
            "Iredell, NC"
          ],
          "rock hill": [
            "York, SC"
          ],
          "rock hill, sc": [
            "York, SC"
          ]
        },
        "sourceNames": [
          "Charlotte-Concord-Gastonia, NC-SC"
        ]
      },
      {
        "marketName": "Raleigh-Durham",
        "scrapeHubs": [
          "Raleigh",
          "Durham",
          "Cary",
          "Chapel Hill",
          "Apex",
          "Morrisville",
          "Wake Forest"
        ],
        "aliases": [
          "greater raleigh-durham area",
          "raleigh-durham metro",
          "raleigh-durham metropolitan area",
          "research triangle",
          "triangle area"
        ],
        "focusCounties": [
          "Chatham, NC",
          "Durham, NC",
          "Franklin, NC",
          "Johnston, NC",
          "Orange, NC",
          "Person, NC",
          "Wake, NC"
        ],
        "cityCountyMap": {
          "apex": [
            "Chatham, NC",
            "Wake, NC"
          ],
          "cary": [
            "Chatham, NC",
            "Durham, NC",
            "Wake, NC"
          ],
          "chapel hill": [
            "Durham, NC",
            "Orange, NC"
          ],
          "durham": [
            "Durham, NC",
            "Orange, NC",
            "Wake, NC"
          ],
          "morrisville": [
            "Durham, NC",
            "Wake, NC"
          ],
          "raleigh": [
            "Durham, NC",
            "Wake, NC"
          ],
          "wake forest": [
            "Franklin, NC",
            "Wake, NC"
          ]
        },
        "sourceNames": [
          "Raleigh-Cary, NC",
          "Durham-Chapel Hill, NC"
        ]
      },
      {
        "marketName": "Greensboro",
        "scrapeHubs": [
          "Greensboro",
          "High Point",
          "Burlington",
          "Asheboro",
          "Reidsville",
          "Kernersville",
          "Thomasville",
          "Jamestown"
        ],
        "aliases": [
          "greater greensboro area",
          "greensboro metro",
          "greensboro metropolitan area",
          "piedmont triad"
        ],
        "focusCounties": [
          "Guilford, NC",
          "Randolph, NC",
          "Rockingham, NC"
        ],
        "cityCountyMap": {
          "asheboro": [
            "Randolph, NC"
          ],
          "burlington": [
            "Guilford, NC"
          ],
          "greensboro": [
            "Guilford, NC"
          ],
          "high point": [
            "Guilford, NC",
            "Randolph, NC"
          ],
          "jamestown": [
            "Guilford, NC"
          ],
          "kernersville": [
            "Guilford, NC"
          ],
          "reidsville": [
            "Rockingham, NC"
          ],
          "thomasville": [
            "Randolph, NC"
          ]
        },
        "sourceNames": [
          "Greensboro-High Point, NC"
        ]
      },
      {
        "marketName": "Winston-Salem",
        "scrapeHubs": [
          "Winston-Salem",
          "Kernersville",
          "Clemmons",
          "Lewisville",
          "Mocksville",
          "Lexington",
          "Thomasville",
          "High Point"
        ],
        "aliases": [
          "greater winston-salem area",
          "piedmont triad",
          "winston-salem metro",
          "winston-salem metropolitan area"
        ],
        "focusCounties": [
          "Davidson, NC",
          "Davie, NC",
          "Forsyth, NC",
          "Stokes, NC",
          "Yadkin, NC"
        ],
        "cityCountyMap": {
          "clemmons": [
            "Forsyth, NC"
          ],
          "high point": [
            "Davidson, NC",
            "Forsyth, NC"
          ],
          "kernersville": [
            "Forsyth, NC"
          ],
          "lewisville": [
            "Forsyth, NC"
          ],
          "lexington": [
            "Davidson, NC"
          ],
          "mocksville": [
            "Davie, NC"
          ],
          "thomasville": [
            "Davidson, NC"
          ],
          "winston-salem": [
            "Forsyth, NC"
          ]
        },
        "sourceNames": [
          "Winston-Salem, NC"
        ]
      }
    ]
  },
  {
    "stateName": "Virginia",
    "stateAbbr": "VA",
    "defaultMarket": "Northern Virginia",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Northern Virginia",
        "scrapeHubs": [
          "Arlington",
          "Alexandria",
          "Fairfax",
          "Reston",
          "Tysons",
          "Manassas",
          "Leesburg",
          "Woodbridge"
        ],
        "aliases": [
          "greater northern virginia area",
          "northern va",
          "northern virginia metro",
          "northern virginia metropolitan area",
          "nova",
          "washington dc metro virginia"
        ],
        "focusCounties": [
          "Alexandria, VA",
          "Arlington, VA",
          "Charles, MD",
          "Clarke, VA",
          "Culpeper, VA",
          "District of Columbia, DC",
          "Fairfax, VA",
          "Falls Church, VA",
          "Fauquier, VA",
          "Frederick, MD",
          "Fredericksburg, VA",
          "Jefferson, WV",
          "Loudoun, VA",
          "Manassas Park, VA",
          "Manassas, VA",
          "Montgomery, MD",
          "Prince George's, MD",
          "Prince William, VA",
          "Rappahannock, VA",
          "Spotsylvania, VA",
          "Stafford, VA",
          "Warren, VA"
        ],
        "cityCountyMap": {
          "alexandria": [
            "Alexandria, VA"
          ],
          "arlington": [
            "Arlington, VA"
          ],
          "fairfax": [
            "Fairfax, VA"
          ],
          "leesburg": [
            "Loudoun, VA"
          ],
          "manassas": [
            "Manassas, VA"
          ],
          "reston": [
            "Fairfax, VA"
          ],
          "tysons": [
            "Fairfax, VA"
          ],
          "woodbridge": [
            "Prince William, VA"
          ]
        },
        "independentCities": [
          "Alexandria",
          "Fairfax",
          "Manassas"
        ],
        "sourceNames": [
          "Washington-Arlington-Alexandria, DC-VA-MD-WV"
        ]
      },
      {
        "marketName": "Richmond",
        "scrapeHubs": [
          "Richmond",
          "Henrico",
          "Glen Allen",
          "Chesterfield",
          "Midlothian",
          "Petersburg",
          "Mechanicsville",
          "Short Pump"
        ],
        "aliases": [
          "greater richmond area",
          "richmond metro",
          "richmond metropolitan area"
        ],
        "focusCounties": [
          "Amelia, VA",
          "Charles City, VA",
          "Chesterfield, VA",
          "Colonial Heights, VA",
          "Dinwiddie, VA",
          "Goochland, VA",
          "Hanover, VA",
          "Henrico, VA",
          "Hopewell, VA",
          "King William, VA",
          "King and Queen, VA",
          "New Kent, VA",
          "Petersburg, VA",
          "Powhatan, VA",
          "Prince George, VA",
          "Richmond, VA",
          "Sussex, VA"
        ],
        "cityCountyMap": {
          "chesterfield": [
            "Chesterfield, VA"
          ],
          "glen allen": [
            "Henrico, VA"
          ],
          "henrico": [
            "Henrico, VA"
          ],
          "mechanicsville": [
            "Hanover, VA"
          ],
          "midlothian": [
            "Chesterfield, VA"
          ],
          "petersburg": [
            "Petersburg, VA"
          ],
          "richmond": [
            "Richmond, VA"
          ],
          "short pump": [
            "Henrico, VA"
          ]
        },
        "independentCities": [
          "Petersburg",
          "Richmond"
        ],
        "sourceNames": [
          "Richmond, VA"
        ]
      },
      {
        "marketName": "Virginia Beach",
        "scrapeHubs": [
          "Virginia Beach",
          "Chesapeake",
          "Norfolk",
          "Portsmouth",
          "Suffolk",
          "Hampton",
          "Newport News",
          "Williamsburg"
        ],
        "aliases": [
          "greater virginia beach area",
          "hampton roads",
          "virginia beach metro",
          "virginia beach metropolitan area"
        ],
        "focusCounties": [
          "Camden, NC",
          "Chesapeake, VA",
          "Currituck, NC",
          "Gates, NC",
          "Gloucester, VA",
          "Hampton, VA",
          "Isle of Wight, VA",
          "James City, VA",
          "Mathews, VA",
          "Newport News, VA",
          "Norfolk, VA",
          "Poquoson, VA",
          "Portsmouth, VA",
          "Suffolk, VA",
          "Surry, VA",
          "Virginia Beach, VA",
          "Williamsburg, VA",
          "York, VA"
        ],
        "cityCountyMap": {
          "chesapeake": [
            "Chesapeake, VA"
          ],
          "hampton": [
            "Hampton, VA"
          ],
          "newport news": [
            "Newport News, VA"
          ],
          "norfolk": [
            "Norfolk, VA"
          ],
          "portsmouth": [
            "Portsmouth, VA"
          ],
          "suffolk": [
            "Suffolk, VA"
          ],
          "virginia beach": [
            "Virginia Beach, VA"
          ],
          "williamsburg": [
            "Williamsburg, VA"
          ]
        },
        "independentCities": [
          "Chesapeake",
          "Hampton",
          "Newport News",
          "Norfolk",
          "Portsmouth",
          "Suffolk",
          "Virginia Beach",
          "Williamsburg"
        ],
        "sourceNames": [
          "Virginia Beach-Chesapeake-Norfolk, VA-NC"
        ]
      },
      {
        "marketName": "Norfolk",
        "scrapeHubs": [
          "Norfolk",
          "Virginia Beach",
          "Chesapeake",
          "Portsmouth",
          "Suffolk",
          "Hampton",
          "Newport News",
          "Williamsburg"
        ],
        "aliases": [
          "greater norfolk area",
          "hampton roads",
          "norfolk metro",
          "norfolk metropolitan area",
          "norfolk-virginia beach"
        ],
        "focusCounties": [
          "Camden, NC",
          "Chesapeake, VA",
          "Currituck, NC",
          "Gates, NC",
          "Gloucester, VA",
          "Hampton, VA",
          "Isle of Wight, VA",
          "James City, VA",
          "Mathews, VA",
          "Newport News, VA",
          "Norfolk, VA",
          "Poquoson, VA",
          "Portsmouth, VA",
          "Suffolk, VA",
          "Surry, VA",
          "Virginia Beach, VA",
          "Williamsburg, VA",
          "York, VA"
        ],
        "cityCountyMap": {
          "chesapeake": [
            "Chesapeake, VA"
          ],
          "hampton": [
            "Hampton, VA"
          ],
          "newport news": [
            "Newport News, VA"
          ],
          "norfolk": [
            "Norfolk, VA"
          ],
          "portsmouth": [
            "Portsmouth, VA"
          ],
          "suffolk": [
            "Suffolk, VA"
          ],
          "virginia beach": [
            "Virginia Beach, VA"
          ],
          "williamsburg": [
            "Williamsburg, VA"
          ]
        },
        "independentCities": [
          "Chesapeake",
          "Hampton",
          "Newport News",
          "Norfolk",
          "Portsmouth",
          "Suffolk",
          "Virginia Beach",
          "Williamsburg"
        ],
        "sourceNames": [
          "Virginia Beach-Chesapeake-Norfolk, VA-NC"
        ]
      },
      {
        "marketName": "Manassas",
        "scrapeHubs": [
          "Manassas",
          "Manassas Park",
          "Centreville",
          "Gainesville",
          "Haymarket",
          "Woodbridge",
          "Fairfax"
        ],
        "aliases": [
          "greater manassas area",
          "manassas metro",
          "manassas metropolitan area"
        ],
        "focusCounties": [
          "Alexandria, VA",
          "Arlington, VA",
          "Charles, MD",
          "Clarke, VA",
          "Culpeper, VA",
          "District of Columbia, DC",
          "Fairfax, VA",
          "Falls Church, VA",
          "Fauquier, VA",
          "Frederick, MD",
          "Fredericksburg, VA",
          "Jefferson, WV",
          "Loudoun, VA",
          "Manassas Park, VA",
          "Manassas, VA",
          "Montgomery, MD",
          "Prince George's, MD",
          "Prince William, VA",
          "Rappahannock, VA",
          "Spotsylvania, VA",
          "Stafford, VA",
          "Warren, VA"
        ],
        "cityCountyMap": {
          "centreville": [
            "Fairfax, VA"
          ],
          "fairfax": [
            "Fairfax, VA"
          ],
          "gainesville": [
            "Prince William, VA"
          ],
          "haymarket": [
            "Prince William, VA"
          ],
          "manassas": [
            "Manassas, VA"
          ],
          "manassas park": [
            "Manassas Park, VA"
          ],
          "woodbridge": [
            "Prince William, VA"
          ]
        },
        "independentCities": [
          "Fairfax",
          "Manassas",
          "Manassas Park"
        ],
        "sourceNames": [
          "Washington-Arlington-Alexandria, DC-VA-MD-WV"
        ]
      }
    ]
  },
  {
    "stateName": "Ohio",
    "stateAbbr": "OH",
    "defaultMarket": "Columbus",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Columbus",
        "scrapeHubs": [
          "Columbus",
          "Dublin",
          "Westerville",
          "Grove City",
          "Hilliard",
          "Gahanna",
          "Reynoldsburg",
          "New Albany"
        ],
        "aliases": [
          "columbus metro",
          "columbus metropolitan area",
          "greater columbus area"
        ],
        "focusCounties": [
          "Delaware, OH",
          "Fairfield, OH",
          "Franklin, OH",
          "Hocking, OH",
          "Licking, OH",
          "Madison, OH",
          "Morrow, OH",
          "Perry, OH",
          "Pickaway, OH",
          "Union, OH"
        ],
        "cityCountyMap": {
          "columbus": [
            "Delaware, OH",
            "Fairfield, OH",
            "Franklin, OH"
          ],
          "dublin": [
            "Delaware, OH",
            "Franklin, OH",
            "Union, OH"
          ],
          "gahanna": [
            "Franklin, OH"
          ],
          "grove": [
            "Franklin, OH"
          ],
          "grove city": [
            "Franklin, OH"
          ],
          "hilliard": [
            "Franklin, OH"
          ],
          "new albany": [
            "Franklin, OH",
            "Licking, OH"
          ],
          "reynoldsburg": [
            "Fairfield, OH",
            "Franklin, OH",
            "Licking, OH"
          ],
          "westerville": [
            "Delaware, OH",
            "Franklin, OH"
          ]
        },
        "sourceNames": [
          "Columbus, OH"
        ]
      },
      {
        "marketName": "Cincinnati",
        "scrapeHubs": [
          "Cincinnati",
          "Hamilton",
          "Middletown",
          "Mason",
          "Fairfield",
          "Blue Ash",
          "West Chester",
          "Florence, KY"
        ],
        "aliases": [
          "cincinnati metro",
          "cincinnati metropolitan area",
          "greater cincinnati area"
        ],
        "focusCounties": [
          "Boone, KY",
          "Bracken, KY",
          "Brown, OH",
          "Butler, OH",
          "Campbell, KY",
          "Clermont, OH",
          "Dearborn, IN",
          "Franklin, IN",
          "Gallatin, KY",
          "Grant, KY",
          "Hamilton, OH",
          "Kenton, KY",
          "Ohio, IN",
          "Pendleton, KY",
          "Warren, OH"
        ],
        "cityCountyMap": {
          "blue ash": [
            "Hamilton, OH"
          ],
          "cincinnati": [
            "Hamilton, OH"
          ],
          "fairfield": [
            "Butler, OH",
            "Hamilton, OH"
          ],
          "florence": [
            "Boone, KY"
          ],
          "florence, ky": [
            "Boone, KY"
          ],
          "hamilton": [
            "Butler, OH"
          ],
          "mason": [
            "Warren, OH"
          ],
          "middletown": [
            "Butler, OH",
            "Warren, OH"
          ],
          "west chester": [
            "Butler, OH"
          ]
        },
        "sourceNames": [
          "Cincinnati, OH-KY-IN"
        ]
      },
      {
        "marketName": "Cleveland",
        "scrapeHubs": [
          "Cleveland",
          "Parma",
          "Lakewood",
          "Elyria",
          "Mentor",
          "Solon",
          "Beachwood"
        ],
        "aliases": [
          "cleveland metro",
          "cleveland metropolitan area",
          "greater cleveland area"
        ],
        "focusCounties": [
          "Ashtabula, OH",
          "Cuyahoga, OH",
          "Geauga, OH",
          "Lake, OH",
          "Lorain, OH",
          "Medina, OH"
        ],
        "cityCountyMap": {
          "beachwood": [
            "Cuyahoga, OH"
          ],
          "cleveland": [
            "Cuyahoga, OH"
          ],
          "elyria": [
            "Lorain, OH"
          ],
          "lakewood": [
            "Cuyahoga, OH"
          ],
          "mentor": [
            "Lake, OH"
          ],
          "parma": [
            "Cuyahoga, OH"
          ],
          "solon": [
            "Cuyahoga, OH"
          ]
        },
        "sourceNames": [
          "Cleveland, OH"
        ]
      },
      {
        "marketName": "Dayton",
        "scrapeHubs": [
          "Dayton",
          "Kettering",
          "Beavercreek",
          "Miamisburg",
          "Fairborn",
          "Huber Heights",
          "Troy"
        ],
        "aliases": [
          "dayton metro",
          "dayton metropolitan area",
          "greater dayton area"
        ],
        "focusCounties": [
          "Greene, OH",
          "Miami, OH",
          "Montgomery, OH"
        ],
        "cityCountyMap": {
          "beavercreek": [
            "Greene, OH"
          ],
          "dayton": [
            "Greene, OH",
            "Montgomery, OH"
          ],
          "fairborn": [
            "Greene, OH"
          ],
          "huber heights": [
            "Miami, OH",
            "Montgomery, OH"
          ],
          "kettering": [
            "Greene, OH",
            "Montgomery, OH"
          ],
          "miamisburg": [
            "Montgomery, OH"
          ],
          "troy": [
            "Miami, OH"
          ]
        },
        "sourceNames": [
          "Dayton-Kettering-Beavercreek, OH"
        ]
      },
      {
        "marketName": "Toledo",
        "scrapeHubs": [
          "Toledo",
          "Maumee",
          "Perrysburg",
          "Sylvania",
          "Oregon",
          "Bowling Green",
          "Waterville"
        ],
        "aliases": [
          "greater toledo area",
          "toledo metro",
          "toledo metropolitan area"
        ],
        "focusCounties": [
          "Fulton, OH",
          "Lucas, OH",
          "Wood, OH"
        ],
        "cityCountyMap": {
          "bowling green": [
            "Wood, OH"
          ],
          "maumee": [
            "Lucas, OH"
          ],
          "oregon": [
            "Lucas, OH"
          ],
          "perrysburg": [
            "Wood, OH"
          ],
          "sylvania": [
            "Lucas, OH"
          ],
          "toledo": [
            "Lucas, OH"
          ],
          "waterville": [
            "Lucas, OH"
          ]
        },
        "sourceNames": [
          "Toledo, OH"
        ]
      }
    ]
  },
  {
    "stateName": "Tennessee",
    "stateAbbr": "TN",
    "defaultMarket": "Nashville",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Nashville",
        "scrapeHubs": [
          "Nashville",
          "Franklin",
          "Murfreesboro",
          "Hendersonville",
          "Smyrna",
          "Brentwood",
          "Gallatin",
          "Lebanon"
        ],
        "aliases": [
          "greater nashville area",
          "nashville metro",
          "nashville metropolitan area"
        ],
        "focusCounties": [
          "Cannon, TN",
          "Cheatham, TN",
          "Davidson, TN",
          "Dickson, TN",
          "Hickman, TN",
          "Macon, TN",
          "Maury, TN",
          "Robertson, TN",
          "Rutherford, TN",
          "Smith, TN",
          "Sumner, TN",
          "Trousdale, TN",
          "Williamson, TN",
          "Wilson, TN"
        ],
        "cityCountyMap": {
          "brentwood": [
            "Williamson, TN"
          ],
          "franklin": [
            "Williamson, TN"
          ],
          "gallatin": [
            "Sumner, TN"
          ],
          "hendersonville": [
            "Sumner, TN"
          ],
          "lebanon": [
            "Wilson, TN"
          ],
          "murfreesboro": [
            "Rutherford, TN"
          ],
          "nashville": [
            "Davidson, TN"
          ],
          "smyrna": [
            "Rutherford, TN",
            "Williamson, TN"
          ]
        },
        "sourceNames": [
          "Nashville-Davidson--Murfreesboro--Franklin, TN"
        ]
      },
      {
        "marketName": "Chattanooga",
        "scrapeHubs": [
          "Chattanooga",
          "Ooltewah",
          "East Ridge",
          "Soddy-Daisy",
          "Red Bank",
          "Collegedale"
        ],
        "aliases": [
          "chattanooga metro",
          "chattanooga metropolitan area",
          "greater chattanooga area"
        ],
        "focusCounties": [
          "Catoosa, GA",
          "Dade, GA",
          "Hamilton, TN",
          "Marion, TN",
          "Sequatchie, TN",
          "Walker, GA"
        ],
        "cityCountyMap": {
          "chattanooga": [
            "Hamilton, TN"
          ],
          "collegedale": [
            "Hamilton, TN"
          ],
          "east ridge": [
            "Hamilton, TN"
          ],
          "ooltewah": [
            "Hamilton, TN"
          ],
          "red bank": [
            "Hamilton, TN"
          ],
          "soddy-daisy": [
            "Hamilton, TN"
          ]
        },
        "sourceNames": [
          "Chattanooga, TN-GA"
        ]
      },
      {
        "marketName": "Knoxville",
        "scrapeHubs": [
          "Knoxville",
          "Maryville",
          "Oak Ridge",
          "Alcoa",
          "Farragut",
          "Clinton",
          "Lenoir City"
        ],
        "aliases": [
          "greater knoxville area",
          "knoxville metro",
          "knoxville metropolitan area"
        ],
        "focusCounties": [
          "Anderson, TN",
          "Blount, TN",
          "Campbell, TN",
          "Grainger, TN",
          "Knox, TN",
          "Loudon, TN",
          "Morgan, TN",
          "Roane, TN",
          "Union, TN"
        ],
        "cityCountyMap": {
          "alcoa": [
            "Blount, TN"
          ],
          "clinton": [
            "Anderson, TN"
          ],
          "farragut": [
            "Knox, TN",
            "Loudon, TN"
          ],
          "knoxville": [
            "Knox, TN"
          ],
          "lenoir": [
            "Loudon, TN"
          ],
          "lenoir city": [
            "Loudon, TN"
          ],
          "maryville": [
            "Blount, TN"
          ],
          "oak ridge": [
            "Anderson, TN",
            "Roane, TN"
          ]
        },
        "sourceNames": [
          "Knoxville, TN"
        ]
      },
      {
        "marketName": "Memphis",
        "scrapeHubs": [
          "Memphis",
          "Bartlett",
          "Germantown",
          "Collierville",
          "Arlington",
          "Millington",
          "Lakeland"
        ],
        "aliases": [
          "greater memphis area",
          "memphis metro",
          "memphis metropolitan area"
        ],
        "focusCounties": [
          "Benton, MS",
          "Crittenden, AR",
          "DeSoto, MS",
          "Fayette, TN",
          "Marshall, MS",
          "Shelby, TN",
          "Tate, MS",
          "Tipton, TN",
          "Tunica, MS"
        ],
        "cityCountyMap": {
          "arlington": [
            "Shelby, TN"
          ],
          "bartlett": [
            "Shelby, TN"
          ],
          "collierville": [
            "Shelby, TN"
          ],
          "germantown": [
            "Shelby, TN"
          ],
          "lakeland": [
            "Shelby, TN"
          ],
          "memphis": [
            "Shelby, TN"
          ],
          "millington": [
            "Shelby, TN"
          ]
        },
        "sourceNames": [
          "Memphis, TN-MS-AR"
        ]
      }
    ]
  },
  {
    "stateName": "South Carolina",
    "stateAbbr": "SC",
    "defaultMarket": "Charleston",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Charleston",
        "scrapeHubs": [
          "Charleston",
          "North Charleston",
          "Mount Pleasant",
          "Summerville",
          "Goose Creek",
          "Hanahan",
          "Ladson",
          "Moncks Corner"
        ],
        "aliases": [
          "charleston metro",
          "charleston metropolitan area",
          "greater charleston area"
        ],
        "focusCounties": [
          "Berkeley, SC",
          "Charleston, SC",
          "Dorchester, SC"
        ],
        "cityCountyMap": {
          "charleston": [
            "Berkeley, SC",
            "Charleston, SC"
          ],
          "goose creek": [
            "Berkeley, SC"
          ],
          "hanahan": [
            "Berkeley, SC"
          ],
          "ladson": [
            "Berkeley, SC",
            "Charleston, SC"
          ],
          "moncks corner": [
            "Berkeley, SC"
          ],
          "mount pleasant": [
            "Charleston, SC"
          ],
          "north charleston": [
            "Berkeley, SC",
            "Charleston, SC",
            "Dorchester, SC"
          ],
          "summerville": [
            "Berkeley, SC",
            "Charleston, SC",
            "Dorchester, SC"
          ]
        },
        "sourceNames": [
          "Charleston-North Charleston, SC"
        ]
      },
      {
        "marketName": "Greenville",
        "scrapeHubs": [
          "Greenville",
          "Greer",
          "Mauldin",
          "Simpsonville",
          "Taylors",
          "Easley",
          "Travelers Rest",
          "Anderson"
        ],
        "aliases": [
          "greater greenville area",
          "greenville metro",
          "greenville metropolitan area",
          "upstate south carolina"
        ],
        "focusCounties": [
          "Anderson, SC",
          "Greenville, SC",
          "Laurens, SC",
          "Pickens, SC"
        ],
        "cityCountyMap": {
          "anderson": [
            "Anderson, SC"
          ],
          "easley": [
            "Anderson, SC",
            "Pickens, SC"
          ],
          "greenville": [
            "Greenville, SC"
          ],
          "greer": [
            "Greenville, SC"
          ],
          "mauldin": [
            "Greenville, SC"
          ],
          "simpsonville": [
            "Greenville, SC"
          ],
          "taylors": [
            "Greenville, SC"
          ],
          "travelers rest": [
            "Greenville, SC"
          ]
        },
        "sourceNames": [
          "Greenville-Anderson-Greer, SC"
        ]
      },
      {
        "marketName": "Columbia",
        "scrapeHubs": [
          "Columbia",
          "Lexington",
          "West Columbia",
          "Cayce",
          "Irmo",
          "Forest Acres",
          "Blythewood"
        ],
        "aliases": [
          "columbia metro",
          "columbia metropolitan area",
          "greater columbia area"
        ],
        "focusCounties": [
          "Calhoun, SC",
          "Fairfield, SC",
          "Kershaw, SC",
          "Lexington, SC",
          "Richland, SC",
          "Saluda, SC"
        ],
        "cityCountyMap": {
          "blythewood": [
            "Fairfield, SC",
            "Richland, SC"
          ],
          "cayce": [
            "Lexington, SC",
            "Richland, SC"
          ],
          "columbia": [
            "Lexington, SC",
            "Richland, SC"
          ],
          "forest acres": [
            "Richland, SC"
          ],
          "irmo": [
            "Lexington, SC",
            "Richland, SC"
          ],
          "lexington": [
            "Lexington, SC"
          ],
          "west columbia": [
            "Lexington, SC"
          ]
        },
        "sourceNames": [
          "Columbia, SC"
        ]
      },
      {
        "marketName": "Spartanburg",
        "scrapeHubs": [
          "Spartanburg",
          "Greer",
          "Boiling Springs",
          "Duncan",
          "Inman",
          "Union",
          "Woodruff"
        ],
        "aliases": [
          "greater spartanburg area",
          "spartanburg metro",
          "spartanburg metropolitan area"
        ],
        "focusCounties": [
          "Spartanburg, SC",
          "Union, SC"
        ],
        "cityCountyMap": {
          "boiling springs": [
            "Spartanburg, SC"
          ],
          "duncan": [
            "Spartanburg, SC"
          ],
          "greer": [
            "Spartanburg, SC"
          ],
          "inman": [
            "Spartanburg, SC"
          ],
          "spartanburg": [
            "Spartanburg, SC"
          ],
          "union": [
            "Union, SC"
          ],
          "woodruff": [
            "Spartanburg, SC"
          ]
        },
        "sourceNames": [
          "Spartanburg, SC"
        ]
      }
    ]
  },
  {
    "stateName": "Arizona",
    "stateAbbr": "AZ",
    "defaultMarket": "Phoenix",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Phoenix",
        "scrapeHubs": [
          "Phoenix",
          "Scottsdale",
          "Mesa",
          "Chandler",
          "Glendale",
          "Tempe",
          "Peoria",
          "Gilbert"
        ],
        "aliases": [
          "greater phoenix area",
          "phoenix metro",
          "phoenix metropolitan area"
        ],
        "focusCounties": [
          "Maricopa, AZ",
          "Pinal, AZ"
        ],
        "cityCountyMap": {
          "chandler": [
            "Maricopa, AZ"
          ],
          "gilbert": [
            "Maricopa, AZ"
          ],
          "glendale": [
            "Maricopa, AZ"
          ],
          "mesa": [
            "Maricopa, AZ"
          ],
          "peoria": [
            "Maricopa, AZ"
          ],
          "phoenix": [
            "Maricopa, AZ"
          ],
          "scottsdale": [
            "Maricopa, AZ"
          ],
          "tempe": [
            "Maricopa, AZ"
          ]
        },
        "sourceNames": [
          "Phoenix-Mesa-Chandler, AZ"
        ]
      },
      {
        "marketName": "Scottsdale",
        "scrapeHubs": [
          "Scottsdale",
          "Phoenix",
          "Tempe",
          "Mesa",
          "Paradise Valley",
          "Fountain Hills",
          "Cave Creek",
          "Carefree"
        ],
        "aliases": [
          "greater scottsdale area",
          "scottsdale metro",
          "scottsdale metropolitan area"
        ],
        "focusCounties": [
          "Maricopa, AZ",
          "Pinal, AZ"
        ],
        "cityCountyMap": {
          "carefree": [
            "Maricopa, AZ"
          ],
          "cave creek": [
            "Maricopa, AZ"
          ],
          "fountain hills": [
            "Maricopa, AZ"
          ],
          "mesa": [
            "Maricopa, AZ"
          ],
          "paradise valley": [
            "Maricopa, AZ"
          ],
          "phoenix": [
            "Maricopa, AZ"
          ],
          "scottsdale": [
            "Maricopa, AZ"
          ],
          "tempe": [
            "Maricopa, AZ"
          ]
        },
        "sourceNames": [
          "Phoenix-Mesa-Chandler, AZ"
        ]
      },
      {
        "marketName": "Mesa",
        "scrapeHubs": [
          "Mesa",
          "Gilbert",
          "Chandler",
          "Tempe",
          "Apache Junction",
          "Queen Creek",
          "Scottsdale",
          "Phoenix"
        ],
        "aliases": [
          "greater mesa area",
          "mesa metro",
          "mesa metropolitan area"
        ],
        "focusCounties": [
          "Maricopa, AZ",
          "Pinal, AZ"
        ],
        "cityCountyMap": {
          "apache junction": [
            "Maricopa, AZ",
            "Pinal, AZ"
          ],
          "chandler": [
            "Maricopa, AZ"
          ],
          "gilbert": [
            "Maricopa, AZ"
          ],
          "mesa": [
            "Maricopa, AZ"
          ],
          "phoenix": [
            "Maricopa, AZ"
          ],
          "queen creek": [
            "Maricopa, AZ",
            "Pinal, AZ"
          ],
          "scottsdale": [
            "Maricopa, AZ"
          ],
          "tempe": [
            "Maricopa, AZ"
          ]
        },
        "sourceNames": [
          "Phoenix-Mesa-Chandler, AZ"
        ]
      },
      {
        "marketName": "Chandler",
        "scrapeHubs": [
          "Chandler",
          "Gilbert",
          "Mesa",
          "Tempe",
          "Phoenix",
          "Scottsdale",
          "Queen Creek"
        ],
        "aliases": [
          "chandler metro",
          "chandler metropolitan area",
          "greater chandler area"
        ],
        "focusCounties": [
          "Maricopa, AZ",
          "Pinal, AZ"
        ],
        "cityCountyMap": {
          "chandler": [
            "Maricopa, AZ"
          ],
          "gilbert": [
            "Maricopa, AZ"
          ],
          "mesa": [
            "Maricopa, AZ"
          ],
          "phoenix": [
            "Maricopa, AZ"
          ],
          "queen creek": [
            "Maricopa, AZ",
            "Pinal, AZ"
          ],
          "scottsdale": [
            "Maricopa, AZ"
          ],
          "tempe": [
            "Maricopa, AZ"
          ]
        },
        "sourceNames": [
          "Phoenix-Mesa-Chandler, AZ"
        ]
      }
    ]
  },
  {
    "stateName": "Pennsylvania",
    "stateAbbr": "PA",
    "defaultMarket": "Philadelphia",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Philadelphia",
        "scrapeHubs": [
          "Philadelphia",
          "King of Prussia",
          "Norristown",
          "Media",
          "Bensalem",
          "West Chester",
          "Doylestown",
          "Chester"
        ],
        "aliases": [
          "greater philadelphia area",
          "philadelphia metro",
          "philadelphia metropolitan area"
        ],
        "focusCounties": [
          "Bucks, PA",
          "Burlington, NJ",
          "Camden, NJ",
          "Cecil, MD",
          "Chester, PA",
          "Delaware, PA",
          "Gloucester, NJ",
          "Montgomery, PA",
          "New Castle, DE",
          "Philadelphia, PA",
          "Salem, NJ"
        ],
        "cityCountyMap": {
          "bensalem": [
            "Bucks, PA"
          ],
          "chester": [
            "Delaware, PA"
          ],
          "doylestown": [
            "Bucks, PA"
          ],
          "king of prussia": [
            "Montgomery, PA"
          ],
          "media": [
            "Delaware, PA"
          ],
          "norristown": [
            "Montgomery, PA"
          ],
          "philadelphia": [
            "Philadelphia, PA"
          ],
          "west chester": [
            "Chester, PA"
          ]
        },
        "sourceNames": [
          "Philadelphia-Camden-Wilmington, PA-NJ-DE-MD"
        ]
      },
      {
        "marketName": "Pittsburgh",
        "scrapeHubs": [
          "Pittsburgh",
          "Monroeville",
          "Cranberry Township",
          "Bethel Park",
          "Mount Lebanon",
          "Greensburg",
          "Washington",
          "Butler"
        ],
        "aliases": [
          "greater pittsburgh area",
          "pittsburgh metro",
          "pittsburgh metropolitan area"
        ],
        "focusCounties": [
          "Allegheny, PA",
          "Armstrong, PA",
          "Beaver, PA",
          "Butler, PA",
          "Fayette, PA",
          "Lawrence, PA",
          "Washington, PA",
          "Westmoreland, PA"
        ],
        "cityCountyMap": {
          "bethel park": [
            "Allegheny, PA"
          ],
          "butler": [
            "Butler, PA"
          ],
          "cranberry": [
            "Butler, PA"
          ],
          "cranberry township": [
            "Butler, PA"
          ],
          "greensburg": [
            "Westmoreland, PA"
          ],
          "monroeville": [
            "Allegheny, PA"
          ],
          "mount lebanon": [
            "Allegheny, PA"
          ],
          "pittsburgh": [
            "Allegheny, PA"
          ],
          "washington": [
            "Washington, PA"
          ]
        },
        "sourceNames": [
          "Pittsburgh, PA"
        ]
      },
      {
        "marketName": "Harrisburg",
        "scrapeHubs": [
          "Harrisburg",
          "Carlisle",
          "Mechanicsburg",
          "Camp Hill",
          "Middletown",
          "Hershey"
        ],
        "aliases": [
          "greater harrisburg area",
          "harrisburg metro",
          "harrisburg metropolitan area"
        ],
        "focusCounties": [
          "Cumberland, PA",
          "Dauphin, PA",
          "Perry, PA"
        ],
        "cityCountyMap": {
          "camp hill": [
            "Cumberland, PA"
          ],
          "carlisle": [
            "Cumberland, PA"
          ],
          "harrisburg": [
            "Dauphin, PA"
          ],
          "hershey": [
            "Dauphin, PA"
          ],
          "mechanicsburg": [
            "Cumberland, PA"
          ],
          "middletown": [
            "Dauphin, PA"
          ]
        },
        "sourceNames": [
          "Harrisburg-Carlisle, PA"
        ]
      },
      {
        "marketName": "Allentown",
        "scrapeHubs": [
          "Allentown",
          "Bethlehem",
          "Easton",
          "Emmaus",
          "Nazareth"
        ],
        "aliases": [
          "allentown metro",
          "allentown metropolitan area",
          "greater allentown area",
          "lehigh valley"
        ],
        "focusCounties": [
          "Carbon, PA",
          "Lehigh, PA",
          "Northampton, PA",
          "Warren, NJ"
        ],
        "cityCountyMap": {
          "allentown": [
            "Lehigh, PA"
          ],
          "bethlehem": [
            "Lehigh, PA",
            "Northampton, PA"
          ],
          "easton": [
            "Northampton, PA"
          ],
          "emmaus": [
            "Lehigh, PA"
          ],
          "nazareth": [
            "Northampton, PA"
          ]
        },
        "sourceNames": [
          "Allentown-Bethlehem-Easton, PA-NJ"
        ]
      }
    ]
  },
  {
    "stateName": "Illinois",
    "stateAbbr": "IL",
    "defaultMarket": "Chicago",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Chicago",
        "scrapeHubs": [
          "Chicago",
          "Aurora",
          "Naperville",
          "Joliet",
          "Elgin",
          "Schaumburg",
          "Evanston",
          "Oak Brook"
        ],
        "aliases": [
          "chicago metro",
          "chicago metropolitan area",
          "greater chicago area"
        ],
        "focusCounties": [
          "Cook, IL",
          "DeKalb, IL",
          "DuPage, IL",
          "Grundy, IL",
          "Jasper, IN",
          "Kane, IL",
          "Kendall, IL",
          "Lake, IL",
          "Lake, IN",
          "McHenry, IL",
          "Newton, IN",
          "Porter, IN",
          "Will, IL"
        ],
        "cityCountyMap": {
          "aurora": [
            "DuPage, IL",
            "Kane, IL",
            "Kendall, IL",
            "Will, IL"
          ],
          "chicago": [
            "Cook, IL",
            "DuPage, IL"
          ],
          "elgin": [
            "Cook, IL",
            "Kane, IL"
          ],
          "evanston": [
            "Cook, IL"
          ],
          "joliet": [
            "Kendall, IL",
            "Will, IL"
          ],
          "naperville": [
            "DuPage, IL",
            "Will, IL"
          ],
          "oak brook": [
            "Cook, IL",
            "DuPage, IL"
          ],
          "schaumburg": [
            "Cook, IL",
            "DuPage, IL"
          ]
        },
        "sourceNames": [
          "Chicago-Naperville-Elgin, IL-IN"
        ]
      },
      {
        "marketName": "Rockford",
        "scrapeHubs": [
          "Rockford",
          "Belvidere",
          "Machesney Park",
          "Loves Park",
          "Roscoe",
          "Winnebago"
        ],
        "aliases": [
          "greater rockford area",
          "rockford metro",
          "rockford metropolitan area"
        ],
        "focusCounties": [
          "Boone, IL",
          "Winnebago, IL"
        ],
        "cityCountyMap": {
          "belvidere": [
            "Boone, IL"
          ],
          "loves park": [
            "Boone, IL",
            "Winnebago, IL"
          ],
          "machesney park": [
            "Winnebago, IL"
          ],
          "rockford": [
            "Winnebago, IL"
          ],
          "roscoe": [
            "Winnebago, IL"
          ],
          "winnebago": [
            "Winnebago, IL"
          ]
        },
        "sourceNames": [
          "Rockford, IL"
        ]
      },
      {
        "marketName": "Peoria",
        "scrapeHubs": [
          "Peoria",
          "East Peoria",
          "Pekin",
          "Morton",
          "Washington",
          "Dunlap",
          "Bartonville"
        ],
        "aliases": [
          "greater peoria area",
          "peoria metro",
          "peoria metropolitan area"
        ],
        "focusCounties": [
          "Marshall, IL",
          "Peoria, IL",
          "Stark, IL",
          "Tazewell, IL",
          "Woodford, IL"
        ],
        "cityCountyMap": {
          "bartonville": [
            "Peoria, IL"
          ],
          "dunlap": [
            "Peoria, IL"
          ],
          "east peoria": [
            "Tazewell, IL"
          ],
          "morton": [
            "Tazewell, IL"
          ],
          "pekin": [
            "Peoria, IL",
            "Tazewell, IL"
          ],
          "peoria": [
            "Peoria, IL"
          ],
          "washington": [
            "Tazewell, IL"
          ]
        },
        "sourceNames": [
          "Peoria, IL"
        ]
      }
    ]
  },
  {
    "stateName": "Indiana",
    "stateAbbr": "IN",
    "defaultMarket": "Indianapolis",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Indianapolis",
        "scrapeHubs": [
          "Indianapolis",
          "Carmel",
          "Fishers",
          "Noblesville",
          "Greenwood",
          "Plainfield",
          "Avon",
          "Zionsville"
        ],
        "aliases": [
          "greater indianapolis area",
          "indianapolis metro",
          "indianapolis metropolitan area"
        ],
        "focusCounties": [
          "Boone, IN",
          "Brown, IN",
          "Hamilton, IN",
          "Hancock, IN",
          "Hendricks, IN",
          "Johnson, IN",
          "Madison, IN",
          "Marion, IN",
          "Morgan, IN",
          "Shelby, IN",
          "Tipton, IN"
        ],
        "cityCountyMap": {
          "avon": [
            "Hendricks, IN"
          ],
          "carmel": [
            "Hamilton, IN"
          ],
          "fishers": [
            "Hamilton, IN"
          ],
          "greenwood": [
            "Johnson, IN"
          ],
          "indianapolis": [
            "Marion, IN"
          ],
          "noblesville": [
            "Hamilton, IN"
          ],
          "plainfield": [
            "Hendricks, IN"
          ],
          "zionsville": [
            "Boone, IN"
          ]
        },
        "sourceNames": [
          "Indianapolis-Carmel-Greenwood, IN"
        ]
      },
      {
        "marketName": "Fort Wayne",
        "scrapeHubs": [
          "Fort Wayne",
          "New Haven",
          "Columbia City",
          "Bluffton"
        ],
        "aliases": [
          "fort wayne metro",
          "fort wayne metropolitan area",
          "greater fort wayne area"
        ],
        "focusCounties": [
          "Allen, IN",
          "Wells, IN",
          "Whitley, IN"
        ],
        "cityCountyMap": {
          "bluffton": [
            "Wells, IN"
          ],
          "columbia": [
            "Whitley, IN"
          ],
          "columbia city": [
            "Whitley, IN"
          ],
          "fort wayne": [
            "Allen, IN"
          ],
          "new haven": [
            "Allen, IN"
          ]
        },
        "sourceNames": [
          "Fort Wayne, IN"
        ]
      },
      {
        "marketName": "South Bend",
        "scrapeHubs": [
          "South Bend",
          "Mishawaka",
          "Niles, MI",
          "Granger"
        ],
        "aliases": [
          "greater south bend area",
          "south bend metro",
          "south bend metropolitan area"
        ],
        "focusCounties": [
          "Cass, MI",
          "St. Joseph, IN"
        ],
        "cityCountyMap": {
          "granger": [
            "St. Joseph, IN"
          ],
          "mishawaka": [
            "St. Joseph, IN"
          ],
          "niles": [
            "Cass, MI"
          ],
          "niles, mi": [
            "Cass, MI"
          ],
          "south bend": [
            "St. Joseph, IN"
          ]
        },
        "sourceNames": [
          "South Bend-Mishawaka, IN-MI"
        ]
      },
      {
        "marketName": "Evansville",
        "scrapeHubs": [
          "Evansville",
          "Newburgh",
          "Boonville",
          "Mount Vernon"
        ],
        "aliases": [
          "evansville metro",
          "evansville metropolitan area",
          "greater evansville area"
        ],
        "focusCounties": [
          "Posey, IN",
          "Vanderburgh, IN",
          "Warrick, IN"
        ],
        "cityCountyMap": {
          "boonville": [
            "Warrick, IN"
          ],
          "evansville": [
            "Vanderburgh, IN"
          ],
          "mount vernon": [
            "Posey, IN"
          ],
          "newburgh": [
            "Warrick, IN"
          ]
        },
        "sourceNames": [
          "Evansville, IN"
        ]
      }
    ]
  },
  {
    "stateName": "Michigan",
    "stateAbbr": "MI",
    "defaultMarket": "Detroit",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Detroit",
        "scrapeHubs": [
          "Detroit",
          "Warren",
          "Troy",
          "Dearborn",
          "Livonia",
          "Southfield",
          "Novi"
        ],
        "aliases": [
          "detroit metro",
          "detroit metropolitan area",
          "greater detroit area"
        ],
        "focusCounties": [
          "Lapeer, MI",
          "Livingston, MI",
          "Macomb, MI",
          "Oakland, MI",
          "St. Clair, MI",
          "Wayne, MI"
        ],
        "cityCountyMap": {
          "dearborn": [
            "Wayne, MI"
          ],
          "detroit": [
            "Wayne, MI"
          ],
          "livonia": [
            "Wayne, MI"
          ],
          "novi": [
            "Oakland, MI"
          ],
          "southfield": [
            "Oakland, MI"
          ],
          "troy": [
            "Oakland, MI"
          ],
          "warren": [
            "Macomb, MI"
          ]
        },
        "sourceNames": [
          "Detroit-Warren-Dearborn, MI"
        ]
      },
      {
        "marketName": "Grand Rapids",
        "scrapeHubs": [
          "Grand Rapids",
          "Wyoming",
          "Kentwood",
          "Holland",
          "Walker",
          "Hudsonville",
          "Rockford"
        ],
        "aliases": [
          "grand rapids metro",
          "grand rapids metropolitan area",
          "greater grand rapids area"
        ],
        "focusCounties": [
          "Barry, MI",
          "Ionia, MI",
          "Kent, MI",
          "Montcalm, MI",
          "Ottawa, MI"
        ],
        "cityCountyMap": {
          "grand rapids": [
            "Kent, MI"
          ],
          "holland": [
            "Ottawa, MI"
          ],
          "hudsonville": [
            "Ottawa, MI"
          ],
          "kentwood": [
            "Kent, MI"
          ],
          "rockford": [
            "Kent, MI"
          ],
          "walker": [
            "Kent, MI"
          ],
          "wyoming": [
            "Kent, MI"
          ]
        },
        "sourceNames": [
          "Grand Rapids-Wyoming-Kentwood, MI"
        ]
      },
      {
        "marketName": "Ann Arbor",
        "scrapeHubs": [
          "Ann Arbor",
          "Ypsilanti",
          "Saline",
          "Chelsea",
          "Dexter"
        ],
        "aliases": [
          "ann arbor metro",
          "ann arbor metropolitan area",
          "greater ann arbor area"
        ],
        "focusCounties": [
          "Washtenaw, MI"
        ],
        "cityCountyMap": {
          "ann arbor": [
            "Washtenaw, MI"
          ],
          "chelsea": [
            "Washtenaw, MI"
          ],
          "dexter": [
            "Washtenaw, MI"
          ],
          "saline": [
            "Washtenaw, MI"
          ],
          "ypsilanti": [
            "Washtenaw, MI"
          ]
        },
        "sourceNames": [
          "Ann Arbor, MI"
        ]
      },
      {
        "marketName": "Lansing",
        "scrapeHubs": [
          "Lansing",
          "East Lansing",
          "Okemos",
          "Haslett",
          "Holt",
          "Grand Ledge",
          "Mason",
          "Charlotte"
        ],
        "aliases": [
          "greater lansing area",
          "lansing metro",
          "lansing metropolitan area"
        ],
        "focusCounties": [
          "Clinton, MI",
          "Eaton, MI",
          "Ingham, MI"
        ],
        "cityCountyMap": {
          "charlotte": [
            "Eaton, MI"
          ],
          "east lansing": [
            "Clinton, MI",
            "Ingham, MI"
          ],
          "grand ledge": [
            "Clinton, MI",
            "Eaton, MI"
          ],
          "haslett": [
            "Ingham, MI"
          ],
          "holt": [
            "Ingham, MI"
          ],
          "lansing": [
            "Clinton, MI",
            "Eaton, MI",
            "Ingham, MI"
          ],
          "mason": [
            "Ingham, MI"
          ],
          "okemos": [
            "Ingham, MI"
          ]
        },
        "sourceNames": [
          "Lansing-East Lansing, MI"
        ]
      }
    ]
  },
  {
    "stateName": "Colorado",
    "stateAbbr": "CO",
    "defaultMarket": "Denver",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Denver",
        "scrapeHubs": [
          "Denver",
          "Aurora",
          "Lakewood",
          "Centennial",
          "Broomfield",
          "Littleton",
          "Englewood"
        ],
        "aliases": [
          "denver metro",
          "denver metropolitan area",
          "greater denver area"
        ],
        "focusCounties": [
          "Adams, CO",
          "Arapahoe, CO",
          "Broomfield, CO",
          "Clear Creek, CO",
          "Denver, CO",
          "Douglas, CO",
          "Elbert, CO",
          "Gilpin, CO",
          "Jefferson, CO",
          "Park, CO"
        ],
        "cityCountyMap": {
          "aurora": [
            "Adams, CO",
            "Arapahoe, CO",
            "Douglas, CO"
          ],
          "broomfield": [
            "Broomfield, CO"
          ],
          "centennial": [
            "Arapahoe, CO"
          ],
          "denver": [
            "Denver, CO"
          ],
          "englewood": [
            "Arapahoe, CO"
          ],
          "lakewood": [
            "Jefferson, CO"
          ],
          "littleton": [
            "Arapahoe, CO",
            "Douglas, CO",
            "Jefferson, CO"
          ]
        },
        "sourceNames": [
          "Denver-Aurora-Centennial, CO"
        ]
      },
      {
        "marketName": "Colorado Springs",
        "scrapeHubs": [
          "Colorado Springs",
          "Fountain",
          "Monument",
          "Manitou Springs",
          "Woodland Park",
          "Security-Widefield"
        ],
        "aliases": [
          "colorado springs metro",
          "colorado springs metropolitan area",
          "greater colorado springs area"
        ],
        "focusCounties": [
          "El Paso, CO",
          "Teller, CO"
        ],
        "cityCountyMap": {
          "colorado springs": [
            "El Paso, CO"
          ],
          "fountain": [
            "El Paso, CO"
          ],
          "manitou springs": [
            "El Paso, CO"
          ],
          "monument": [
            "El Paso, CO"
          ],
          "security-widefield": [
            "El Paso, CO"
          ],
          "woodland park": [
            "Teller, CO"
          ]
        },
        "sourceNames": [
          "Colorado Springs, CO"
        ]
      },
      {
        "marketName": "Boulder",
        "scrapeHubs": [
          "Boulder",
          "Longmont",
          "Lafayette",
          "Louisville",
          "Superior",
          "Erie",
          "Gunbarrel"
        ],
        "aliases": [
          "boulder metro",
          "boulder metropolitan area",
          "greater boulder area"
        ],
        "focusCounties": [
          "Boulder, CO"
        ],
        "cityCountyMap": {
          "boulder": [
            "Boulder, CO"
          ],
          "erie": [
            "Boulder, CO"
          ],
          "gunbarrel": [
            "Boulder, CO"
          ],
          "lafayette": [
            "Boulder, CO"
          ],
          "longmont": [
            "Boulder, CO"
          ],
          "louisville": [
            "Boulder, CO"
          ],
          "superior": [
            "Boulder, CO"
          ]
        },
        "sourceNames": [
          "Boulder, CO"
        ]
      },
      {
        "marketName": "Fort Collins",
        "scrapeHubs": [
          "Fort Collins",
          "Loveland",
          "Windsor",
          "Timnath",
          "Wellington",
          "Johnstown",
          "Berthoud"
        ],
        "aliases": [
          "fort collins metro",
          "fort collins metropolitan area",
          "greater fort collins area"
        ],
        "focusCounties": [
          "Larimer, CO"
        ],
        "cityCountyMap": {
          "berthoud": [
            "Larimer, CO"
          ],
          "fort collins": [
            "Larimer, CO"
          ],
          "johnstown": [
            "Larimer, CO"
          ],
          "loveland": [
            "Larimer, CO"
          ],
          "timnath": [
            "Larimer, CO"
          ],
          "wellington": [
            "Larimer, CO"
          ],
          "windsor": [
            "Larimer, CO"
          ]
        },
        "sourceNames": [
          "Fort Collins-Loveland, CO"
        ]
      }
    ]
  },
  {
    "stateName": "New Jersey",
    "stateAbbr": "NJ",
    "defaultMarket": "Northern New Jersey",
    "sourceBasis": [
      "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
      "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/documentation/Geos20235YR.txt",
      "Policy: full OMB/Census CBSA or Metropolitan Division county sets are included, including cross-state county-equivalents; hub city strings carry their true state when cross-state."
    ],
    "markets": [
      {
        "marketName": "Newark",
        "scrapeHubs": [
          "Newark",
          "Elizabeth",
          "East Orange",
          "Bloomfield",
          "Irvington",
          "Union",
          "Montclair"
        ],
        "aliases": [
          "greater newark area",
          "newark metro",
          "newark metropolitan area"
        ],
        "focusCounties": [
          "Essex, NJ",
          "Hunterdon, NJ",
          "Morris, NJ",
          "Sussex, NJ",
          "Union, NJ"
        ],
        "cityCountyMap": {
          "bloomfield": [
            "Essex, NJ"
          ],
          "east orange": [
            "Essex, NJ"
          ],
          "elizabeth": [
            "Union, NJ"
          ],
          "irvington": [
            "Essex, NJ"
          ],
          "montclair": [
            "Essex, NJ"
          ],
          "newark": [
            "Essex, NJ"
          ],
          "union": [
            "Union, NJ"
          ]
        },
        "sourceNames": [
          "Newark, NJ"
        ]
      },
      {
        "marketName": "Jersey City",
        "scrapeHubs": [
          "Jersey City",
          "Hoboken",
          "Bayonne",
          "Union City",
          "North Bergen",
          "Secaucus",
          "Weehawken",
          "Kearny"
        ],
        "aliases": [
          "greater jersey city area",
          "jersey city metro",
          "jersey city metropolitan area"
        ],
        "focusCounties": [
          "Bergen, NJ",
          "Bronx, NY",
          "Hudson, NJ",
          "Kings, NY",
          "New York, NY",
          "Passaic, NJ",
          "Putnam, NY",
          "Queens, NY",
          "Richmond, NY",
          "Rockland, NY",
          "Westchester, NY"
        ],
        "cityCountyMap": {
          "bayonne": [
            "Hudson, NJ"
          ],
          "hoboken": [
            "Hudson, NJ"
          ],
          "jersey": [
            "Hudson, NJ"
          ],
          "jersey city": [
            "Hudson, NJ"
          ],
          "kearny": [
            "Hudson, NJ"
          ],
          "north bergen": [
            "Hudson, NJ"
          ],
          "secaucus": [
            "Hudson, NJ"
          ],
          "union": [
            "Hudson, NJ"
          ],
          "union city": [
            "Hudson, NJ"
          ],
          "weehawken": [
            "Hudson, NJ"
          ]
        },
        "sourceNames": [
          "New York-Jersey City-White Plains, NY-NJ"
        ]
      },
      {
        "marketName": "Princeton",
        "scrapeHubs": [
          "Princeton",
          "Trenton",
          "Hamilton",
          "Lawrence Township",
          "West Windsor",
          "Hopewell",
          "Ewing"
        ],
        "aliases": [
          "greater princeton area",
          "princeton metro",
          "princeton metropolitan area"
        ],
        "focusCounties": [
          "Mercer, NJ"
        ],
        "cityCountyMap": {
          "ewing": [
            "Mercer, NJ"
          ],
          "hamilton": [
            "Mercer, NJ"
          ],
          "hopewell": [
            "Mercer, NJ"
          ],
          "lawrence": [
            "Mercer, NJ"
          ],
          "lawrence township": [
            "Mercer, NJ"
          ],
          "princeton": [
            "Mercer, NJ"
          ],
          "trenton": [
            "Mercer, NJ"
          ],
          "west windsor": [
            "Mercer, NJ"
          ]
        },
        "sourceNames": [
          "Trenton-Princeton, NJ"
        ]
      },
      {
        "marketName": "Morristown",
        "scrapeHubs": [
          "Morristown",
          "Parsippany",
          "Madison",
          "Florham Park",
          "Morris Plains",
          "Dover",
          "Denville",
          "Chatham"
        ],
        "aliases": [
          "greater morristown area",
          "morristown metro",
          "morristown metropolitan area"
        ],
        "focusCounties": [
          "Essex, NJ",
          "Hunterdon, NJ",
          "Morris, NJ",
          "Sussex, NJ",
          "Union, NJ"
        ],
        "cityCountyMap": {
          "chatham": [
            "Morris, NJ"
          ],
          "denville": [
            "Morris, NJ"
          ],
          "dover": [
            "Morris, NJ"
          ],
          "florham park": [
            "Morris, NJ"
          ],
          "madison": [
            "Morris, NJ"
          ],
          "morris plains": [
            "Morris, NJ"
          ],
          "morristown": [
            "Morris, NJ"
          ],
          "parsippany": [
            "Morris, NJ"
          ]
        },
        "sourceNames": [
          "Newark, NJ"
        ]
      },
      {
        "marketName": "Northern New Jersey",
        "scrapeHubs": [
          "Newark",
          "Jersey City",
          "Paterson",
          "Hackensack",
          "Elizabeth",
          "Clifton",
          "Paramus",
          "Morristown"
        ],
        "aliases": [
          "greater northern new jersey area",
          "north jersey",
          "northern new jersey metro",
          "northern new jersey metropolitan area",
          "northern nj"
        ],
        "focusCounties": [
          "Bergen, NJ",
          "Bronx, NY",
          "Essex, NJ",
          "Hudson, NJ",
          "Hunterdon, NJ",
          "Kings, NY",
          "Morris, NJ",
          "New York, NY",
          "Passaic, NJ",
          "Putnam, NY",
          "Queens, NY",
          "Richmond, NY",
          "Rockland, NY",
          "Sussex, NJ",
          "Union, NJ",
          "Westchester, NY"
        ],
        "cityCountyMap": {
          "clifton": [
            "Passaic, NJ"
          ],
          "elizabeth": [
            "Union, NJ"
          ],
          "hackensack": [
            "Bergen, NJ"
          ],
          "jersey": [
            "Hudson, NJ"
          ],
          "jersey city": [
            "Hudson, NJ"
          ],
          "morristown": [
            "Morris, NJ"
          ],
          "newark": [
            "Essex, NJ"
          ],
          "paramus": [
            "Bergen, NJ"
          ],
          "paterson": [
            "Passaic, NJ"
          ]
        },
        "sourceNames": [
          "Newark, NJ",
          "New York-Jersey City-White Plains, NY-NJ"
        ]
      }
    ]
  }
];

export function toStateGeoConfig(
  seed: ReviewableStateGeoSeed,
  marketName = seed.defaultMarket,
): StateGeoConfig {
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
      {
        marketName: m.marketName,
        metroCities: m.scrapeHubs,
        metroAliases: m.aliases,
        focusCounties: m.focusCounties,
      },
    ]),
  );

  return {
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
  };
}

export function reviewNotes(): Array<{
  stateName: string;
  marketName: string;
  notes: string[];
}> {
  return [];
}
