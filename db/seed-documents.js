// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... node db/seed-documents.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DOCUMENTS = [
  {
    title: 'ADA Standards of Care 2024 — Pharmacologic Treatment',
    source: 'ADA, 2024',
    content: 'Metformin remains first-line pharmacologic treatment for type 2 diabetes unless contraindicated. For patients with established CVD or high CVD risk, an SGLT2 inhibitor or GLP-1 RA with proven CVD benefit is recommended. HbA1c target is generally <7% for most adults.',
    language: 'en',
  },
  {
    title: 'WHO Essential Medicines — Community Acquired Pneumonia',
    source: 'WHO, 2023',
    content: 'Amoxicillin is recommended for community-acquired pneumonia in outpatient settings for mild-moderate severity. Duration: 5 days for mild CAP. For atypical pathogens, add a macrolide (azithromycin) or use a respiratory fluoroquinolone.',
    language: 'en',
  },
  {
    title: 'ACC/AHA Chest Pain Guideline 2021',
    source: 'ACC/AHA, 2021',
    content: 'High-sensitivity troponin assay is the preferred biomarker for ACS evaluation. A 0/1-hour or 0/2-hour accelerated diagnostic protocol is recommended. TIMI and HEART scores assist risk stratification. Low-risk patients (HEART score ≤3) can be safely discharged.',
    language: 'en',
  },
  {
    title: 'แนวทางเวชปฏิบัติเบาหวาน 2566 — การรักษาด้วยยา',
    source: 'สมาคมโรคเบาหวานแห่งประเทศไทย, 2566',
    content: 'เมตฟอร์มินเป็นยาตัวแรกที่แนะนำในการรักษาเบาหวานชนิดที่ 2 หากไม่มีข้อห้าม เป้าหมาย HbA1c < 7% สำหรับผู้ป่วยส่วนใหญ่ ในผู้ป่วยที่มีโรคหัวใจและหลอดเลือด ให้พิจารณา SGLT2 inhibitor หรือ GLP-1 RA ที่มีหลักฐานลดเหตุการณ์ CV',
    language: 'th',
  },
];

async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? 'Embedding failed');
  return data.data[0].embedding;
}

async function seed() {
  console.log('Seeding RAG documents...');
  for (const doc of DOCUMENTS) {
    process.stdout.write(`  ${doc.title}... `);
    try {
      const embedding = await embed(doc.content);
      const { error } = await supabase.from('documents').insert({ ...doc, embedding });
      if (error) console.error('FAILED:', error.message);
      else console.log('✓');
    } catch (e) {
      console.error('FAILED:', e.message);
    }
  }
  console.log('Done.');
}

seed().catch(console.error);
