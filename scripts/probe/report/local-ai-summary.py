#!/usr/bin/env python3
"""
Plain-language summary of the local-AI (on-prem DGX) testing, for a non-technical reader.

Emits docs/reports/local-ai-test-summary.{docx,html}. The PDF is rendered from the HTML by
scripts/report/local-ai-summary-pdf.mjs (Playwright), because Thai needs a real shaping engine and
document.fonts.ready before printing or vowels render as tofu.

Numbers here are transcribed from docs/GATE0-DGX-RESULTS.md. No transcript text appears.
"""
import pathlib
from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

OUT = pathlib.Path('docs/reports')
OUT.mkdir(parents=True, exist_ok=True)

TITLE_TH = "สรุปผลการทดสอบ AI ภายในองค์กร (Local AI) สำหรับระบบ CLICS"
TITLE_EN = "Summary — Testing the In-House AI for CLICS"
SUB = "ทดสอบวันที่ 31 สิงหาคม – 1 กันยายน 2569 · Tested 31 Aug – 1 Sep 2026"

# (heading_th, heading_en, [ (para_th, para_en), ... ])
BODY = [
("1. เราทดสอบอะไร", "1. What we tested", [
 ("เรานำบทสนทนาการเรียนรู้ของแพทย์ 26 ชุด ที่ลบข้อมูลส่วนบุคคลออกแล้ว มาให้ AI สองตัวให้คะแนนด้วยเกณฑ์เดียวกัน "
  "คือ AI ภายในองค์กรที่ติดตั้งบนเครื่อง DGX และ AI ภายนอกที่ระบบใช้อยู่ในปัจจุบัน",
  "We took 26 real physician learning episodes, with all personal information removed, and asked two "
  "AI systems to grade them using exactly the same criteria: the in-house AI on the DGX machine, and "
  "the external AI the system uses today."),
 ("คำถามคือ ถ้าเปลี่ยนไปใช้ AI ภายใน คะแนนที่แพทย์ได้รับจะเปลี่ยนไปหรือไม่",
  "The question: if we switched to the in-house AI, would the scores physicians receive change?"),
]),
("2. ข่าวดี", "2. The good news", [
 ("AI ภายในทำงานได้จริง ให้คำตอบในรูปแบบที่ระบบอ่านได้ 25 จาก 26 ครั้ง (96%) ผ่านเกณฑ์ที่ตั้งไว้ "
  "และ AI ภายนอกก็ได้ 25 จาก 26 เท่ากันพอดี ไม่ได้ดีกว่ากัน",
  "The in-house AI works. It returned a usable answer 25 times out of 26 (96%), which passes our "
  "threshold — and the external AI scored exactly the same, 25 out of 26. Neither is better on this."),
 ("ตอบภาษาไทยได้ครบถ้วนทั้ง 6 ข้อที่ทดสอบ",
  "It answered in Thai correctly on all 6 Thai test cases."),
 ("ความเร็ว: AI ภายในใช้เวลาราว 68 วินาทีต่อครั้ง AI ภายนอกราว 22 วินาที ช้ากว่าประมาณ 3 เท่า "
  "แต่ยังอยู่ในระดับที่ระบบรองรับได้ และเพียงพอสำหรับจำนวนผู้ใช้ในโครงการนำร่อง",
  "Speed: the in-house AI takes about 68 seconds per episode; the external one about 22 seconds. "
  "About 3× slower, but still within what the system allows, and fast enough for the pilot's size."),
 ("ค่าใช้จ่าย: AI ภายนอกมีค่าใช้จ่ายประมาณ 0.014 ดอลลาร์ต่อครั้ง ส่วน AI ภายในไม่มีค่าใช้จ่ายเพิ่ม "
  "เพราะใช้เครื่องที่มีอยู่แล้ว",
  "Cost: the external AI costs about USD 0.014 per episode. The in-house AI costs nothing extra, "
  "because the hardware is already owned."),
]),
("3. ปัญหาสำคัญที่สุดที่พบ", "3. The most important problem we found", [
 ("เมื่อเราให้ AI ตรวจบทสนทนา “ชุดเดิม” ซ้ำหลายครั้ง คะแนนที่ได้ไม่เท่ากัน",
  "When we asked the AI to grade the same episode several times over, it did not give the same score."),
 ("ตัวอย่าง บทสนทนาชุดหนึ่ง คะแนนเต็ม 35 คะแนน — AI ภายนอกให้ 12, 16, 21 และ 13 ต่างกันถึง 9 คะแนน "
  "ขณะที่ AI ภายในให้ 16, 16, 16, 16 และ 17 ซึ่งนิ่งมาก",
  "On one episode, out of 35 marks, the external AI gave 12, 16, 21 and 13 — a 9-mark spread. "
  "The in-house AI gave 16, 16, 16, 16 and 17 — very steady."),
 ("แต่ในบทสนทนาอีกชุดหนึ่ง ผลกลับตรงกันข้าม AI ภายในเป็นฝ่ายไม่นิ่ง",
  "But on a different episode the result reversed: the in-house AI was the unsteady one."),
 ("สรุปคือ AI ทั้งสองตัวให้คะแนนไม่สม่ำเสมอทั้งคู่ เพียงแต่ไม่สม่ำเสมอกับคนละบทสนทนา "
  "จึงไม่ใช่เรื่องที่แก้ได้ด้วยการเลือก AI ตัวใดตัวหนึ่ง",
  "So both AIs are inconsistent — just on different episodes. This is therefore not a problem you can "
  "solve by picking one AI over the other."),
 ("เปรียบเทียบให้เห็นภาพ: เหมือนอาจารย์ท่านเดิมตรวจข้อสอบใบเดิม แล้วให้คะแนนไม่เท่ากันในแต่ละวัน "
  "โดยที่ข้อสอบไม่ได้เปลี่ยนเลย",
  "An analogy: the same examiner marking the same exam paper on different days, and giving it a "
  "different grade each time — when nothing about the paper has changed."),
 ("ที่น่ากังวลกว่านั้นคือ ความคลาดเคลื่อนไม่ได้กระจายตัวแบบสุ่ม แต่ขยับขึ้นลงพร้อมกันทั้ง 7 ด้าน "
  "(ประมาณ 59% ของความคลาดเคลื่อนทั้งหมด) ผลคือ “คะแนนรวม” ยิ่งคลาดเคลื่อนมากขึ้น ไม่ใช่น้อยลง",
  "More worrying: the errors are not random and independent. About 59% of the wobble moves all seven "
  "domains up or down together. That means the total score is more unreliable than any single "
  "domain, not less."),
]),
("4. ปัญหาเรื่องเครื่องที่ใช้", "4. A problem with the machine itself", [
 ("เครื่อง DGX ที่ใช้ทดสอบไม่ได้อยู่ในความดูแลของโครงการ และมีผู้ใช้รายอื่นใช้งานร่วมอยู่",
  "The DGX machine we tested on is not under the project's control, and other people share it."),
 ("การทดสอบแบบเดียวกัน ครั้งหนึ่งใช้เวลา 57 วินาที อีกครั้งใช้เวลา 16 นาที ห่างกันเพียงสองชั่วโมง "
  "โดยที่เราไม่ได้เปลี่ยนอะไรเลย",
  "The identical test took 57 seconds on one run and 16 minutes on another, two hours apart, with "
  "nothing changed on our side."),
 ("นอกจากนี้ ระบบไม่แสดงหมายเลขรุ่นหรือลายนิ้วมือของโมเดล เราจึงไม่สามารถพิสูจน์ได้ว่าเป็นโมเดลเดิมทุกครั้ง "
  "ซึ่งขัดกับข้อกำหนดการล็อกโมเดล (Model Lock) ในโครงร่างวิจัย CREC082 ข้อ 10.2",
  "The system also does not expose a version number or fingerprint for the model, so we cannot prove "
  "it is the same model each time. That conflicts with the Model Lock requirement in the CREC082 "
  "protocol, section 10.2."),
]),
("5. สรุปและข้อเสนอ", "5. Conclusion and recommendation", [
 ("ในแง่คุณภาพการให้คะแนน AI ภายในทำได้ และไม่ใช่อุปสรรค",
  "On grading quality, the in-house AI is capable. That is not the obstacle."),
 ("อุปสรรคจริงคือความสม่ำเสมอของการให้คะแนน ซึ่งเป็นปัญหาของวิธีการให้คะแนน ไม่ใช่ของ AI ตัวใดตัวหนึ่ง "
  "ดังนั้นการใช้ AI ภายนอกต่อไปก็ไม่ได้แก้ปัญหานี้",
  "The real obstacle is consistency of grading. This is a problem with the grading method itself, not "
  "with either AI — so continuing to use the external AI does not solve it."),
 ("ข้อเสนอ: ยังไม่ควรเปลี่ยนไปใช้ AI ภายในในขณะนี้ และควรจัดการสามเรื่องต่อไปนี้ก่อน",
  "Recommendation: do not switch to the in-house AI yet, and settle these three things first."),
]),
]

STEPS = [
 ("1) ปรับวิธีให้คะแนนให้ผลนิ่งขึ้น แล้ววัดซ้ำ",
  "1) Make the grading method more stable, then re-measure."),
 ("2) จัดหาเครื่องที่โครงการควบคุมได้เอง เพื่อให้รับประกันความเร็วและล็อกรุ่นโมเดลได้",
  "2) Obtain a machine the project controls, so speed can be guaranteed and the model version locked."),
 ("3) เก็บคะแนนจากผู้ตรวจที่เป็นมนุษย์ อย่างน้อย 3 ท่านต่อ 1 บทสนทนา",
  "3) Collect human grades from at least 3 reviewers per episode."),
]

CLOSING_TH = ("ข้อ 3 สำคัญที่สุด ปัจจุบันยังไม่มีบทสนทนาใดที่มีผู้ตรวจครบ 3 ท่าน "
  "จึงยังไม่มีเกณฑ์อ้างอิงว่า “คะแนนที่ถูกต้อง” คืออะไร และหากไม่มีตัวเทียบจากมนุษย์ "
  "เราจะไม่สามารถสรุปได้เลยว่า AI ตัวใดให้คะแนนได้ถูกต้อง")
CLOSING_EN = ("Item 3 matters most. At present no episode has been graded by three reviewers, so we "
  "have no reference for what a correct score even is. Without a human benchmark, we cannot say "
  "which AI grades correctly — only that the two disagree with each other, and with themselves.")

# ---------------------------------------------------------------- DOCX
doc = Document()
st = doc.styles['Normal']
st.font.name = 'TH Sarabun New'
st.font.size = Pt(14)
for s in doc.sections:
    s.left_margin = s.right_margin = Inches(1.0)

def para(text, size=14, bold=False, color=None, space_after=6, italic=False):
    p = doc.add_paragraph()
    r = p.add_run(text)
    r.font.name = 'TH Sarabun New'; r.font.size = Pt(size); r.bold = bold; r.italic = italic
    if color: r.font.color.rgb = color
    p.paragraph_format.space_after = Pt(space_after)
    return p

para(TITLE_TH, size=20, bold=True, space_after=2)
para(TITLE_EN, size=15, bold=True, color=RGBColor(0x66,0x66,0x66), space_after=2)
para(SUB, size=11, color=RGBColor(0x88,0x88,0x88), space_after=14)

for h_th, h_en, paras in BODY:
    para(h_th, size=16, bold=True, space_after=1)
    para(h_en, size=12, bold=True, color=RGBColor(0x88,0x88,0x88), space_after=6)
    for t_th, t_en in paras:
        para(t_th, size=14, space_after=2)
        para(t_en, size=12, color=RGBColor(0x55,0x55,0x55), space_after=10)

for s_th, s_en in STEPS:
    para(s_th, size=14, bold=True, space_after=1)
    para(s_en, size=12, color=RGBColor(0x55,0x55,0x55), space_after=8)

para(CLOSING_TH, size=14, space_after=2)
para(CLOSING_EN, size=12, italic=True, color=RGBColor(0x55,0x55,0x55), space_after=4)

docx_path = OUT / 'local-ai-test-summary.docx'
doc.save(docx_path)
print('wrote', docx_path)

# ---------------------------------------------------------------- HTML (for PDF)
def esc(t): return t.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
h = ['<meta charset="utf-8"><title>สรุปผลการทดสอบ Local AI</title><style>',
 '@page{size:A4;margin:20mm 18mm;}',
 'body{font-family:"TH Sarabun New","Sarabun",sans-serif;color:#1c1c1a;line-height:1.55;}',
 'h1{font-size:23pt;margin:0 0 2pt;}',
 'h1 small{display:block;font-size:14pt;color:#666;font-weight:600;margin-top:2pt;}',
 '.sub{font-size:10.5pt;color:#888;margin:0 0 16pt;}',
 'h2{font-size:16pt;margin:16pt 0 1pt;page-break-after:avoid;}',
 'h2 small{display:block;font-size:11.5pt;color:#888;font-weight:600;}',
 '.pair{break-inside:avoid;page-break-inside:avoid;}',
 '.th{font-size:13.5pt;margin:0 0 1pt;}',
 '.en{font-size:11.5pt;color:#555;margin:0 0 9pt;}',
 '.step{font-size:13.5pt;font-weight:700;margin:8pt 0 1pt;}',
 '.close{font-size:13.5pt;margin-top:14pt;padding-top:10pt;border-top:1px solid #ddd;}',
 '.close-en{font-size:11.5pt;color:#555;font-style:italic;}',
 '</style>',
 f'<h1>{esc(TITLE_TH)}<small>{esc(TITLE_EN)}</small></h1>',
 f'<p class="sub">{esc(SUB)}</p>']
for h_th, h_en, paras in BODY:
    h.append(f'<h2>{esc(h_th)}<small>{esc(h_en)}</small></h2>')
    for t_th, t_en in paras:
        h.append(f'<div class="pair"><p class="th">{esc(t_th)}</p><p class="en">{esc(t_en)}</p></div>')
for s_th, s_en in STEPS:
    h.append(f'<div class="pair"><p class="step">{esc(s_th)}</p><p class="en">{esc(s_en)}</p></div>')
h.append(f'<p class="close">{esc(CLOSING_TH)}</p><p class="close-en">{esc(CLOSING_EN)}</p>')
html_path = OUT / 'local-ai-test-summary.html'
html_path.write_text('\n'.join(h), encoding='utf-8')
print('wrote', html_path)
