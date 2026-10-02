// The ONLY sources an anchor's tutor turns may cite.
//
// WHY AN ALLOWLIST. The tutor prompts demand a (Source, Year) citation in every reply, and the
// anchors are written by an AI. An invented reference in a committed calibration corpus is worse than
// none: it reads as real to every later reader, and the tutor-audit (Phase 3) would then learn that
// fabricated citations are what good replies look like. So every citation in a fixture must match an
// entry here, and validate.mjs fails on anything else. Each entry is a guideline, score or trial the
// author was confident exists, with the year it was published. Adding one is a reviewed diff — do it
// only for a source you can name the publisher and year of without looking it up.
//
// `match` is tested against the citation's source text (before the year); `years` against the year.

export const CITATIONS = [
  // Diabetes / renal / metabolic
  { match: /\bADA\b|American Diabetes Association/i, years: [2023, 2024], what: 'ADA Standards of Care in Diabetes' },
  { match: /KDIGO/i, years: [2022, 2024], what: 'KDIGO Diabetes in CKD 2022 / CKD 2024' },
  { match: /Diabetes Association of Thailand|สมาคมโรคเบาหวานแห่งประเทศไทย|แนวทางเวชปฏิบัติสำหรับโรคเบาหวาน|Thai (DM|Diabetes) (CPG|guideline)/i, years: [2023], what: 'Thai CPG for Diabetes 2023' },
  { match: /Spasovski|European (Clinical Practice )?Guideline.*hyponat|hyponatraemia guideline|hyponatremia guideline/i, years: [2014], what: 'European hyponatraemia CPG (Spasovski et al., 2014)' },
  // Cardiovascular
  { match: /\bESC\b|European Society of Cardiology/i, years: [2018, 2019, 2020, 2021, 2022, 2023, 2024], what: 'ESC guidelines (AF 2020/2024, ACS 2023, syncope 2018, non-cardiac surgery 2022, HT 2024, dyslipidaemia 2019)' },
  { match: /\bAHA\b|\bACC\b|American Heart Association|American College of Cardiology/i, years: [2014, 2017, 2018, 2019, 2023], what: 'ACC/AHA (perioperative 2014, HT 2017, cholesterol 2018, AF 2023) and AHA/ASA stroke 2019' },
  { match: /\bASA\b.*stroke|Powers/i, years: [2019], what: 'AHA/ASA acute ischaemic stroke guideline (Powers et al., 2019)' },
  { match: /\bESH\b|European Society of Hypertension/i, years: [2023], what: 'ESH hypertension guideline 2023' },
  { match: /Thai Hypertension Society|สมาคมความดันโลหิตสูงแห่งประเทศไทย|แนวทางการรักษาโรคความดันโลหิตสูง/i, years: [2019], what: 'Thai Hypertension Society guideline 2019' },
  { match: /CHA2DS2-VASc|Lip et al/i, years: [2010], what: 'CHA2DS2-VASc (Lip et al., 2010)' },
  { match: /HAS-BLED|Pisters/i, years: [2010], what: 'HAS-BLED (Pisters et al., 2010)' },
  { match: /HEART score|Six et al|Backus/i, years: [2008, 2013], what: 'HEART score (Six 2008; Backus 2013)' },
  { match: /BRIDGE|Douketis/i, years: [2015], what: 'BRIDGE trial (Douketis et al., NEJM 2015)' },
  { match: /USPSTF|US Preventive Services Task Force/i, years: [2022], what: 'USPSTF statin primary prevention 2022' },
  { match: /San Francisco Syncope Rule|Quinn/i, years: [2004], what: 'San Francisco Syncope Rule (Quinn et al., 2004)' },
  // Infection / sepsis / respiratory
  { match: /Surviving Sepsis Campaign/i, years: [2021], what: 'Surviving Sepsis Campaign 2021' },
  { match: /IDSA|ATS|Metlay/i, years: [2019], what: 'ATS/IDSA CAP guideline (Metlay et al., 2019)' },
  { match: /CURB-65|Lim et al/i, years: [2003], what: 'CURB-65 (Lim et al., Thorax 2003)' },
  { match: /\bGINA\b|Global Initiative for Asthma/i, years: [2024], what: 'GINA 2024' },
  { match: /\bGOLD\b/i, years: [2024], what: 'GOLD 2024' },
  { match: /\bWHO\b|World Health Organization/i, years: [2009, 2012, 2017], what: 'WHO dengue 2009 / dengue handbook 2012 / PPH recs 2012, 2017' },
  { match: /WOMAN trial|WOMAN Trial Collaborators/i, years: [2017], what: 'WOMAN trial (Lancet 2017)' },
  // Paediatrics
  { match: /\bAAP\b|American Academy of Pediatrics|Pantell|Ralston/i, years: [2011, 2014, 2021], what: 'AAP febrile infant 2021 (Pantell), bronchiolitis 2014 (Ralston), febrile seizure 2011' },
  { match: /\bAAN\b|Hirtz/i, years: [2000], what: 'AAN/CNS first non-febrile seizure in children (Hirtz et al., 2000)' },
  { match: /Kocher/i, years: [1999], what: 'Kocher criteria (1999)' },
  // Obstetrics & gynaecology
  { match: /\bACOG\b|American College of Obstetricians/i, years: [2018, 2020], what: 'ACOG PB 190 GDM (2018), PB 222 pre-eclampsia (2020)' },
  { match: /FIGO|PALM-COEIN|Munro/i, years: [2011, 2018], what: 'FIGO PALM-COEIN (Munro et al., 2011/2018)' },
  // Surgery / emergency / orthopaedics
  { match: /Alvarado/i, years: [1986], what: 'Alvarado score (1986)' },
  { match: /WSES|World Society of Emergency Surgery|Jerusalem guideline|Bologna guideline/i, years: [2017, 2020], what: 'WSES Bologna ASBO 2017, Jerusalem appendicitis 2020' },
  { match: /Tokyo Guidelines|TG18/i, years: [2018], what: 'Tokyo Guidelines 2018' },
  { match: /\bACG\b|American College of Gastroenterology|Laine/i, years: [2021], what: 'ACG upper GI bleeding guideline (Laine et al., 2021)' },
  { match: /Glasgow-Blatchford|Blatchford/i, years: [2000], what: 'Glasgow-Blatchford score (2000)' },
  { match: /Canadian CT Head Rule|Stiell/i, years: [1996, 2001], what: 'Canadian CT Head Rule (2001); Ottawa knee rule (1996)' },
  { match: /Ottawa knee|Ottawa SAH|Perry/i, years: [1996, 2013], what: 'Ottawa knee rule (1996); Ottawa SAH rule (Perry et al., 2013)' },
  { match: /\bNICE\b/i, years: [2010, 2011, 2016, 2022, 2023], what: 'NICE delirium CG103 (2010), alcohol-use disorders CG115 (2011), low back pain NG59 (2016), depression NG222 (2022), head injury NG232 (2023)' },
  { match: /\bAAOS\b|American Academy of Orthopaedic Surgeons/i, years: [2021], what: 'AAOS hip fracture guideline 2021' },
  { match: /Endocrine Society/i, years: [2019], what: 'Endocrine Society osteoporosis guideline 2019' },
  { match: /FRAX/i, years: [2008], what: 'FRAX (Kanis et al., 2008)' },
  { match: /\bBSR\b|British Society for Rheumatology|Coakley/i, years: [2006], what: 'BSR/BOA septic arthritis guideline (Coakley et al., 2006)' },
  { match: /\bACP\b|American College of Physicians|Qaseem/i, years: [2017], what: 'ACP low back pain guideline (Qaseem et al., 2017)' },
  { match: /SNNOOP10|Do et al/i, years: [2019], what: 'SNNOOP10 headache red flags (Do et al., 2019)' },
  // Psychiatry / geriatrics
  { match: /Cipriani/i, years: [2018], what: 'Cipriani et al., Lancet 2018 antidepressant NMA' },
  { match: /CIWA|Sullivan/i, years: [1989], what: 'CIWA-Ar (Sullivan et al., 1989)' },
  { match: /C-SSRS|Columbia|Posner/i, years: [2011], what: 'Columbia Suicide Severity Rating Scale (Posner et al., 2011)' },
  { match: /\bCAM\b|Confusion Assessment Method|Inouye/i, years: [1990], what: 'Confusion Assessment Method (Inouye et al., 1990)' },
  { match: /Beers/i, years: [2023], what: 'AGS Beers Criteria 2023' },
  { match: /STOPP/i, years: [2023], what: 'STOPP/START v3 (2023)' },
];

const YEAR_RE = /(19|20)\d{2}/g;

/**
 * Is this citation's source on the allowlist?
 * @param {string} source  the text inside "( … )", e.g. "Surviving Sepsis Campaign, 2021"
 * @returns {{ok: boolean, entry?: object, year?: number}}
 */
export function checkCitation(source) {
  const years = [...String(source).matchAll(YEAR_RE)].map((m) => Number(m[0]));
  const year = years.at(-1);
  if (!year) return { ok: false };
  const text = String(source).replace(YEAR_RE, '');
  const entry = CITATIONS.find((c) => c.match.test(text) && c.years.includes(year));
  return entry ? { ok: true, entry, year } : { ok: false, year };
}
