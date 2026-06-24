/**
 * Reading Quest — Google Sheet logger (secondary backup / parent oversight).
 *
 * ONE-TIME SETUP
 * 1. Create a Google Sheet. Open Extensions → Apps Script.
 * 2. Delete anything there, paste THIS file, and Save.
 * 3. Deploy → New deployment → type "Web app".
 *      Execute as: Me.   Who has access: Anyone.
 * 4. Copy the Web app URL (ends in /exec).
 * 5. Paste it into the app: Settings → "Google Sheet log".
 *
 * The app POSTs one row per entry. This script only APPENDS — it never
 * deletes. The Sheet is an audit log; your real restore path is the JSON
 * backup file. (The app does not read the Sheet back.)
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["received_at","child","type","book","date","endPage","unitId","note","raw"]);
    }
    var d = JSON.parse(e.postData.contents);
    sheet.appendRow([
      new Date(),
      d.child || "",
      d.type || "",
      d.bookId || "",
      d.date || "",
      d.endPage != null ? d.endPage : "",
      d.unitId || d.qId || "",
      d.complete != null ? ("complete="+d.complete) : "",
      JSON.stringify(d)
    ]);
    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput("Reading Quest logger is running.");
}
