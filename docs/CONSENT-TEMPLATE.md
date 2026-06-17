# Informed Consent & Privacy Notice — TEMPLATE (Stage 1 validation pilot)

> **For your IRB / ethics committee to review and finalize.** Replace every `[[PLACEHOLDER]]`.
> This is a *template*, not approved wording — do not enroll participants until the ethics
> committee has signed off on the final text. Once approved, paste the final TH + EN copy into
> the consent screen (`physician-ui/public/js/dashboard.js`, the `pilotGate()` consent modal).
>
> Scope assumptions baked in: **de-identified / hypothetical cases only**, **no CME credit in
> this phase** (validation only), **cloud AI receives de-identified text**. If any of these
> change, the consent text must change with them.

---

## ภาษาไทย (Thai)

### หนังสือแสดงความยินยอมเข้าร่วมโครงการ

**ชื่อโครงการ:** [[ชื่อโครงการ CLICS — ระยะนำร่องเพื่อตรวจสอบความตรง]]
**หน่วยงานผู้รับผิดชอบ / ผู้วิจัยหลัก:** [[ชื่อ + หน่วยงาน + ข้อมูลติดต่อ]]
**เลขที่รับรองจริยธรรม (IRB):** [[เลขที่]]

**1. วัตถุประสงค์** โครงการนี้ทดสอบระบบ CLICS ซึ่งให้ท่านสนทนาทางคลินิกกับผู้ช่วย AI (Physician Learning Episode — CLE) เพื่อประเมินการให้เหตุผลทางคลินิก โดยมีเป้าหมายเพื่อ**ตรวจสอบความตรงของระบบ** ระยะนี้**ยังไม่ให้หน่วยกิต CME/CPD**

**2. สิ่งที่ท่านต้องทำ** ท่านจะสร้างและสนทนาในกรณีศึกษา **โดยใช้ข้อมูลสมมติ/ไม่ระบุตัวตนผู้ป่วยเท่านั้น** — ห้ามใส่ชื่อ เลขประจำตัวผู้ป่วย (HN) วันที่ หรือข้อมูลที่ระบุตัวบุคคลจริง บทสนทนาจะถูกบันทึกและให้คะแนนโดย AI และผู้ตรวจประเมินผู้เชี่ยวชาญ

**3. การเก็บและคุ้มครองข้อมูล** ระบบเก็บบทสนทนาและคะแนนของท่านโดยผูกกับ**รหัสนิรนาม (เช่น P-001)** ผู้ตรวจประเมินจะเห็นเฉพาะบทสนทนาแบบไม่ระบุตัวตน ข้อความที่ไม่ระบุตัวตนเท่านั้นที่ถูกส่งไปยังบริการ AI บนคลาวด์ ข้อมูลจะถูกเก็บไว้ [[ระยะเวลาเก็บรักษา]] ที่ [[ภูมิภาค/ระบบจัดเก็บ]] และเข้าถึงได้เฉพาะ [[ทีมที่ได้รับอนุญาต]]

**4. ความสมัครใจ** การเข้าร่วมเป็นไปโดยสมัครใจ ท่านสามารถถอนตัวได้ทุกเมื่อโดยไม่มีผลกระทบใด ๆ [[ช่องทางการถอนตัว/ลบข้อมูล]]

**5. ความเสี่ยงและประโยชน์** ความเสี่ยงต่ำเนื่องจากใช้ข้อมูลสมมติ ประโยชน์คือช่วยพัฒนาเครื่องมือประเมินการเรียนรู้ของแพทย์ [[เพิ่มเติมตามที่ IRB กำหนด]]

**6. การติดต่อ** หากมีคำถาม: [[ผู้วิจัย + เบอร์/อีเมล]] ด้านสิทธิผู้เข้าร่วม: [[สำนักงานจริยธรรม + ติดต่อ]]

**คำยินยอม:** ข้าพเจ้าได้อ่านและเข้าใจข้อมูลข้างต้น และยินยอมเข้าร่วมโครงการโดยใช้กรณีที่ไม่ระบุตัวตนผู้ป่วยเท่านั้น — **[ ฉันยินยอม / I consent ]**

---

## English

### Informed Consent to Participate

**Study title:** [[CLICS validation pilot — Stage 1]]
**Sponsor / Principal investigator:** [[name + institution + contact]]
**Ethics approval (IRB) no.:** [[number]]

**1. Purpose.** This study evaluates the CLICS system, in which you hold a clinical dialogue with an AI assistant (a Physician Learning Episode — CLE) that scores clinical reasoning. The aim is **to validate the system**. **No CME/CPD credit is issued in this phase.**

**2. What you will do.** You will create and discuss cases **using de-identified / hypothetical patient information only** — do **not** enter real names, hospital numbers (HN), dates, or any identifying detail. Your dialogues are recorded and scored by AI **and** by expert auditors.

**3. Data handling & protection.** Your dialogues and scores are stored under a **pseudonym (e.g. P-001)**. Auditors see only the de-identified transcript. Only de-identified text is sent to the cloud AI service. Data is retained for [[retention period]] in [[region / storage]] and accessible only to [[authorized team]].

**4. Voluntary participation.** Participation is voluntary; you may withdraw at any time without penalty. [[how to withdraw / request deletion]]

**5. Risks & benefits.** Risk is low because cases are hypothetical. The benefit is contributing to a validated tool for assessing physician clinical reasoning. [[add per IRB]]

**6. Contacts.** Questions about the study: [[investigator + phone/email]]. Questions about your rights as a participant: [[ethics office + contact]].

**Consent statement:** I have read and understood the above and agree to participate, using **de-identified cases only** — **[ I consent / ฉันยินยอม ]**

---

### Mapping to the app
- The **"I consent" button** records `professionals.consented_at`; no CLE session can be created, continued, or ended until it is set (enforced server-side).
- The always-on banner already states *"Use de-identified cases only · scores are provisional (not yet CME credit)."* Keep the consent text consistent with it.
- Place the final approved TH + EN text in the `pilotGate()` consent modal in `physician-ui/public/js/dashboard.js`.
