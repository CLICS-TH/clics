// The identifier labels a booth visitor may type a patient's value after, one row per kind, with the label's Thai and
// English form and a synthetic value in each language (outside every gazetteer and absent from the NFCME-2026 case
// text). Every booth label check reads this one table, so a label kind is added once and is checked in both looks'
// languages (#377, #412).
const BOOTH_LABELS = [
  { kind: 'HN', th: 'HN', en: 'HN', value: { th: '1234567', en: '1234567' } },
  { kind: 'hospital number', th: 'เลข HN', en: 'Hospital number', value: { th: '1234567', en: '1234567' } },
  { kind: 'MRN', th: 'MRN', en: 'MRN', value: { th: '65-012345', en: '65-012345' } },
  { kind: 'ID', th: 'เลขบัตรประชาชน', en: 'ID', value: { th: '1-2345-67890-12-3', en: '1234567' } },
  { kind: 'ID number', th: 'เลขบัตรประชาชน', en: 'ID number', value: { th: '1-2345-67890-12-3', en: '1234567' } },
  { kind: 'name', th: 'ชื่อ', en: 'Name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'patient name', th: 'ชื่อผู้ป่วย', en: 'Patient name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'name, three words', th: 'ชื่อผู้ป่วย', en: 'Patient name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Ames Prewitt' } },
  { kind: 'surname', th: 'นามสกุล', en: 'Surname', value: { th: 'ทองเปลว', en: 'Prewitt' } },
  { kind: 'family name', th: 'นามสกุล', en: 'Family name', value: { th: 'ทองเปลว', en: 'Prewitt' } },
  { kind: 'last name', th: 'นามสกุล', en: 'Last name', value: { th: 'ทองเปลว', en: 'Prewitt' } },
  { kind: 'title Mr', th: 'นาย', en: 'Mr', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title Mrs', th: 'นาง', en: 'Mrs', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title Ms', th: 'นางสาว', en: 'Ms', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title Miss', th: 'นางสาว', en: 'Miss', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'province', th: 'จังหวัด', en: 'Province', value: { th: 'นครปฐม', en: 'Nakhon Pathom' } },
  { kind: 'district', th: 'อำเภอ', en: 'District', value: { th: 'สารภี', en: 'Saraphi' } },
  { kind: 'subdistrict', th: 'ตำบล', en: 'Subdistrict', value: { th: 'บางรัก', en: 'Bang Rak' } },
  { kind: 'village', th: 'หมู่ที่', en: 'Village', value: { th: '12', en: 'Ban Pong' } },
  { kind: 'address', th: 'บ้านเลขที่', en: 'Address', value: { th: '123/45', en: '123/45 Suthep Road' } },
  { kind: 'address, long', th: 'บ้านเลขที่', en: 'Address', value: { th: '123/45', en: '123/45 Soi Wattana Suthep Road Mueang Lamphun' } },
  { kind: 'first name', th: 'ชื่อ', en: 'First name', value: { th: 'พรรณราย', en: 'Dalton' } },
  { kind: 'title, boy', th: 'เด็กชาย', en: 'Name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title, girl', th: 'เด็กหญิง', en: 'Name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title, boy, short', th: 'ด.ช.', en: 'Name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'title, girl, short', th: 'ด.ญ.', en: 'Name', value: { th: 'พรรณราย ทองเปลว', en: 'Dalton Prewitt' } },
  { kind: 'hospital no', th: 'เลข HN', en: 'Hospital no', value: { th: '1234567', en: '1234567' } },
  { kind: 'AN', th: 'AN', en: 'AN', value: { th: '65-001234', en: '65-001234' } },
  { kind: 'national ID', th: 'บัตรประชาชน', en: 'National ID', value: { th: '1-2345-67890-12-3', en: '1234567890123' } },
  { kind: 'citizen ID', th: 'เลขบัตรประชาชน', en: 'Citizen ID', value: { th: '1234567890123', en: '1234567890123' } },
  { kind: 'passport', th: 'บัตรประชาชน', en: 'Passport', value: { th: '1234567890123', en: 'AA1234567' } },
  { kind: 'phone', th: 'เบอร์', en: 'Phone', value: { th: '081-234-5678', en: '081-234-5678' } },
  { kind: 'telephone', th: 'โทร', en: 'Tel', value: { th: '0812345678', en: '0812345678' } },
  { kind: 'mobile', th: 'โทรศัพท์', en: 'Mobile', value: { th: '089 765 4321', en: '089 765 4321' } },
  { kind: 'date of birth', th: 'วันเกิด', en: 'Date of birth', value: { th: '12 มีนาคม 2501', en: '12/03/1958' } },
  { kind: 'DOB', th: 'วันเกิด', en: 'DOB', value: { th: '12/03/2501', en: '12/03/1958' } },
  { kind: 'born', th: 'วันเกิด', en: 'Born', value: { th: '12/03/2501', en: '12 March 1958' } },
  { kind: 'sub-district', th: 'ตำบล', en: 'Sub-district', value: { th: 'บางรัก', en: 'Bang Rak' } },
  { kind: 'village name', th: 'หมู่บ้าน', en: 'Village', value: { th: 'บ้านโป่ง', en: 'Ban Pong' } },
  { kind: 'address, Thai label', th: 'ที่อยู่', en: 'Address', value: { th: '123/45 ถนนสุเทพ', en: '123/45 Suthep Road' } },
];

const LANGUAGES = ['th', 'en'];

// The table in one language as test.each rows, [kind, label, value], the shape of #414's LABELLED rows. Thai rows that
// repeat a label and value (นามสกุล for surname, family name and last name) are listed once.
function labelRows(language) {
  const seen = new Set();
  return BOOTH_LABELS.map((row) => [row.kind, row[language], row.value[language]]).filter(([, label, value]) => {
    const key = `${label}\n${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { BOOTH_LABELS, LANGUAGES, labelRows };
