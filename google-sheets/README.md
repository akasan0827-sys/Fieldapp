# Stock manager: Google Sheets edition

The slab, offcut and glue stock app, running on **your own Google Sheet**. There is no server, VPN or monthly cost: the Sheet stores the data, and Google hosts the app. Your team opens one link on a phone or computer and logs in.

- English / ไทย switch on every screen
- SCM records receipts, deliveries (full slabs, cut by m² with the leftover kept as an offcut, glue by lot), adjustments, rack moves and locks
- Sales see live stock (refreshed every 30 seconds) and request locks
- Monthly closing, sales per day/week/month, 3-month average and months of cover, glue expiry warnings, incoming shipments with ETA
- Every table can be copied into Excel / Google Sheets with one button

The Node.js version in the repository root (`server/`, `public/`) is unchanged and still works if you ever want to run your own server.

**Demo (no setup needed):** https://claude.ai/artifact/9hU7ognNMzT6ByueTB9PzU. The demo keeps its sample data in your browser only. If you open it in two browser tabs, one as SCM and one as Sales, a delivery saved in the SCM tab shows up in the Sales tab within a few seconds.

---

## Set it up (about 15 minutes, one time)

Do this with the Google account that should own the data (for example the company account).

1. **Create the Sheet.** Go to [sheets.new](https://sheets.new) and name it, for example `Stock`.
2. **Open the script editor.** In the Sheet choose **Extensions → Apps Script**.
3. **Paste the server code.** Click `Code.gs` on the left, delete everything in it, and paste the whole content of [`dist/Code.gs`](dist/Code.gs). On GitHub, open the file and use the **Copy raw file** button (two squares, top right of the file).
4. **Paste the app page.** Click **＋ → HTML** next to *Files*, name it exactly `Index` (Google adds `.html`), delete what is in it, and paste the content of [`dist/Index.html`](dist/Index.html).
5. **Set the time zone.** Click the gear (**Project Settings**). Set *Time zone* to **(GMT+07:00) Bangkok**.
6. **Save.** Click 💾 (or press Ctrl+S).
7. **Create the tables.** Go back to the Sheet tab and reload the page. A new menu **Stock app** appears after a few seconds. Choose **Stock app → 1. First-time setup**.
   - Google asks for permission the first time. Choose your account, then **Advanced → Go to … (unsafe) → Allow**. The warning appears because this is your own script and Google has not reviewed it. It only accesses this Sheet.
   - Run **1. First-time setup** again after allowing. A box shows the **admin password**. Write it down.
8. *(Optional)* **Stock app → 2. Load the 28 standard colours, racks and glues** fills in a starting list that you can change later in the app.
9. **Publish the app.** In the Apps Script editor click **Deploy → New deployment**, click the gear next to *Select type* and choose **Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy** and copy the **Web app URL**. This is your app link.
10. **First login.** Open the link and log in as `admin` with the password from step 7. Choose your own password.
11. **Add your team.** Go to **Setup → Users**. Create one login per person and pick the role:
    - **SCM**: stock, deliveries, receipts, locks
    - **Sales**: sees live stock, requests locks
    - **Admin**: everything, including users and monthly closing

    Each person chooses their own password at first login.
12. **Enter the opening stock.** Go to **Setup → Initial stock**. You can paste three columns from your current sheet: colour code, pieces and rack.
13. **Share the link** with the team. On a phone, open it and choose **Add to Home Screen**. It then opens like an app.

> "Who has access: Anyone" means anyone with the link sees the **login page**. Without a username and password nobody can see or change stock. The Google Sheet itself stays private to you.

### Updating to a newer version

1. Paste the new `dist/Code.gs` and `dist/Index.html` over the old ones and save.
2. Click **Deploy → Manage deployments**, then the ✏️ pencil. Under *Version* choose **New version**, then click **Deploy**.

The link stays the same and all data stays in the Sheet.

---

## How it works

- Each table is a tab in the Sheet: `Colours`, `Racks`, `Glue`, `GlueLots`, `Customers`, `Documents`, `Lines`, `Moves`, `Offcuts`, `Locks`, `Closings`, `Users`, `Settings`, `Log`.
- **Please do not type in those tabs.** Use the app, so the stock always adds up. Rows are never deleted: a voided document stays and is marked void.
- The **Stock (live)** tab is rewritten after every save. It is safe to read, filter or copy from it.
- **Backup:** Google keeps every version. In the Sheet choose **File → Version history** to see or restore an earlier state. You can also use **File → Make a copy** at any time.
- Saving takes about 1–3 seconds, because Google runs the code. Two people saving at the same moment are handled one after the other, so nothing is lost.
- Other screens refresh every 30 seconds while they are open (the green **Live** dot).
- Logins are the app's own users (passwords are stored hashed), so staff do not need Google accounts.

### Limits to know

- Google's free quotas are far above what a team of 5–30 people uses.
- After several years of daily use the `Lines` and `Moves` tabs get large (tens of thousands of rows) and pages slow down. When that happens, close the month in the app, start a new Sheet, and enter the closing stock there as the initial stock.

---

## For developers

```bash
cd google-sheets
npm install
npm run build   # writes dist/Code.gs, dist/Index.html, dist/demo.html, dist/appsscript.json
npm test        # engine tests + Code.gs against a simulated Google Sheet
```

- `src/engine.js`: all stock logic (posting, offcuts, glue lots first-expiry-first-out, locks, closing, reports). It is plain JavaScript shared by Apps Script, the demo and the tests. It uses the same API paths as the Node version.
- `src/server.gs.js`: Apps Script layer. It maps tables to tabs, holds a script lock while saving, writes only changed rows, and keeps text cells as text.
- `src/client/`: the screens (ES modules, bundled by esbuild); `th.js` holds the Thai texts. The build stops with a list if any text has no Thai entry.
- `dist/demo.html`: the whole app in one file with the in-browser backend; open it directly in a browser.

---

## ภาษาไทย: วิธีติดตั้ง (ทำครั้งเดียว ประมาณ 15 นาที)

1. สร้าง Google Sheet ใหม่ที่ [sheets.new](https://sheets.new) ตั้งชื่อ เช่น `Stock`
2. เมนู **ส่วนขยาย → Apps Script**
3. คลิก `Code.gs` ลบทั้งหมด แล้ววางเนื้อหาจากไฟล์ [`dist/Code.gs`](dist/Code.gs) (ใน GitHub กดปุ่ม **Copy raw file**)
4. กด **＋ → HTML** ตั้งชื่อว่า `Index` แล้ววางเนื้อหาจาก [`dist/Index.html`](dist/Index.html)
5. กดรูปเฟือง (**การตั้งค่าโปรเจ็กต์**) ตั้งเขตเวลาเป็น **(GMT+07:00) Bangkok**
6. กดบันทึก 💾
7. กลับไปที่ Sheet แล้วรีโหลดหน้า จะมีเมนู **Stock app** → เลือก **1. First-time setup**
   - ครั้งแรก Google จะขออนุญาต: เลือกบัญชี → **ขั้นสูง → ไปที่ … (ไม่ปลอดภัย) → อนุญาต** (ขึ้นเตือนเพราะเป็นสคริปต์ของคุณเอง ใช้กับ Sheet นี้เท่านั้น)
   - กด **1. First-time setup** อีกครั้ง ระบบจะแสดง **รหัสผ่าน admin** ให้จดไว้
8. (ไม่บังคับ) **Stock app → 2. Load the 28 standard colours…** เพื่อใส่รายการสี แร็ค และกาวเริ่มต้น
9. ใน Apps Script กด **ทำให้ใช้งานได้ (Deploy) → การทำให้ใช้งานได้รายการใหม่ → เว็บแอป**
   - เรียกใช้ในฐานะ: **ฉัน (Me)**
   - ผู้ที่มีสิทธิ์เข้าถึง: **ทุกคน (Anyone)**
   - กด Deploy แล้วคัดลอก **URL ของเว็บแอป** นี่คือลิงก์ของแอป
10. เปิดลิงก์ เข้าสู่ระบบด้วย `admin` และรหัสจากข้อ 7 แล้วตั้งรหัสผ่านใหม่
11. ไปที่ **ตั้งค่า → ผู้ใช้งาน** สร้างบัญชีให้พนักงานแต่ละคน (SCM / ฝ่ายขาย / แอดมิน)
12. ไปที่ **ตั้งค่า → สต็อกเริ่มต้น** กรอกหรือวางสต็อกปัจจุบันจาก Excel (รหัสสี, จำนวนแผ่น, แร็ค)
13. ส่งลิงก์ให้ทีม บนมือถือเลือก **เพิ่มไปยังหน้าจอหลัก** จะเปิดได้เหมือนแอป

**สำคัญ:** อย่าพิมพ์แก้ข้อมูลในแท็บของ Sheet โดยตรง ให้ใช้แอปเท่านั้น แท็บ **Stock (live)** เปิดดูและคัดลอกได้ตามสบาย ข้อมูลย้อนหลังดูได้ที่ **ไฟล์ → ประวัติเวอร์ชัน**

**อัปเดตเวอร์ชันใหม่:** วาง `Code.gs` และ `Index.html` ใหม่ทับของเดิม → บันทึก → **Deploy → Manage deployments → ✏️ → Version: New version → Deploy** ลิงก์เดิมใช้ได้ต่อ ข้อมูลไม่หาย
