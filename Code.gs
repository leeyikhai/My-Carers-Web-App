function ensureShiftIds() {
  const sheet    = ss.getSheetByName(SHEET_ROSTER);
  const lastRow  = sheet.getLastRow();
  const idCol    = Columns.SHIFT_ID + 1;  // convert 0-based → 1-based
  const values   = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  const toWrite  = [];
  let changed    = false;

  values.forEach(r => {
    if (!r[0]) {
      toWrite.push([ Utilities.getUuid() ]);
      changed = true;
    } else {
      toWrite.push([ r[0] ]);
    }
  });

  if (changed) {
    sheet.getRange(2, idCol, toWrite.length, 1).setValues(toWrite);
  }
}

function runOnce_backfillIds() {
  ensureShiftIds();
}
function doGet() {
  return HtmlService.createTemplateFromFile('login')
    .evaluate()
    .setTitle('Roster App');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getPage(name) {
  return HtmlService.createTemplateFromFile(name).evaluate().getContent();
}

function getImageData(imageId) {
  try {
    const blob        = DriveApp.getFileById(imageId).getBlob();
    const contentType = blob.getContentType();
    const bytes       = blob.getBytes();
    const b64         = Utilities.base64Encode(bytes);
    return `data:${contentType};base64,${b64}`;
  }
  catch (e) {
    throw new Error('Could not load image: ' + e.message);
  }
}

// ── CONFIG ───────────────────────────────────────────────────
const SPREADSHEET_ID = '1Ch6GopA44puW5J91m27Ew_uVmx6Izkb2coTCWCW0B68';
const SHEET_ROSTER   = 'RosterDB';
const TIMEZONE       = Session.getScriptTimeZone();
const DATE_FORMAT    = 'yyyy-MM-dd';
const TIME_FORMAT    = 'HH:mm';
const Columns = { 
  DATE:0, START:1, END:2, TYPE:3, STAFF_NAME:4, PARTICIPANT:5, STATUS:6, TRANSFER_TO:7,
  SN_DATE:10, SN_STAFF:11, SN_PARTICIPANT:12, SN_NOTE:13, SN_IMAGE:14,
  CONF_DATE:25, CONF_START:26, CONF_END:27, CONF_DUTY:28, CONF_STAFF:29,
  CONF_PARTICIPANT:30, CONF_REASON:31, DESIGNATION:32, LOGIN_NAME:33,
  LOGIN_EMAIL:34, LOGIN_PASS:35, SHIFT_ID: 36
};

function getStaffNames() {
  const sheet     = SpreadsheetApp
                        .openById(SPREADSHEET_ID)
                        .getSheetByName(SHEET_ROSTER);
  if (!sheet) throw new Error(`Sheet "${SHEET_ROSTER}" not found`);
  const colIndex  = Columns.LOGIN_NAME + 1;           // convert 0-based → 1-based
  const lastRow   = sheet.getLastRow();
  if (lastRow < 2) return [];

  // pull only that column, skip header row
  const values    = sheet.getRange(2, colIndex, lastRow - 1, 1)
                        .getValues()
                        .flat()
                        .map(v => v.toString().trim())
                        .filter(Boolean);

  // dedupe & sort
  return Array.from(new Set(values))
              .sort((a, b) => a.localeCompare(b));
}

function getAllShifts() {
  return _getAllRowsCached().map((r, idx) => ({
    id:              r[Columns.SHIFT_ID] || `${r[Columns.STAFF_NAME]}_${_formatDate(r[Columns.DATE])}_${_formatTime(r[Columns.START])}`,
    rowIndex:        idx + 2,

    // ── Unconfirmed shifts ───────────────────────────────────
    date:            _formatDate(r[Columns.DATE]),
    start:           _formatTime(r[Columns.START]),
    end:             _formatTime(r[Columns.END]),
    duty:            r[Columns.TYPE],
    staffName:       r[Columns.STAFF_NAME],
    participant:     r[Columns.PARTICIPANT],
    status:          r[Columns.STATUS]       || '',
    adjustment:      r[Columns.TRANSFER_TO]   || '',

    // ── Shift-notes (“adjustments”) ──────────────────────────
    noteDate:        r[Columns.SN_DATE]        ? _formatDate(r[Columns.SN_DATE]) : '',
    noteStaff:       r[Columns.SN_STAFF]       || '',
    noteParticipant: r[Columns.SN_PARTICIPANT] || '',
    noteText:        r[Columns.SN_NOTE]        || '',
    noteImage:       r[Columns.SN_IMAGE]       || '',

    // ── Confirmed shifts (moves to your “completed” section) ──
    confDate:        r[Columns.CONF_DATE]      ? _formatDate(r[Columns.CONF_DATE])   : '',
    confStart:       r[Columns.CONF_START]     ? _formatTime(r[Columns.CONF_START])  : '',
    confEnd:         r[Columns.CONF_END]       ? _formatTime(r[Columns.CONF_END])    : '',
    confDuty:        r[Columns.CONF_DUTY]      || '',
    confStaff:       r[Columns.CONF_STAFF]     || '',
    confParticipant: r[Columns.CONF_PARTICIPANT] || '',
    confReason:      r[Columns.CONF_REASON]    || ''   // ← your “shift note” on the confirmed side
  }));
}

const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
const sheet = ss.getSheetByName(SHEET_ROSTER);

function processLogin(loginEmail, password) {
  try {
    const inputEmail = loginEmail.toString().trim().toLowerCase();
    const data = sheet
      .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
      .getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const storedEmail = (row[Columns.LOGIN_EMAIL] || '')
        .toString()
        .trim()
        .toLowerCase();
      const storedPass = row[Columns.LOGIN_PASS];

      if (storedEmail === inputEmail && storedPass === password) {
        // pull and normalize designation
        const rawDesig = row[Columns.DESIGNATION] || '';
        const designation = rawDesig.toString().trim();
        const isTeamLeader = /team[- ]?leader/i.test(designation);

        return {
          success: true,
          email: row[Columns.LOGIN_EMAIL].toString().trim(),
          name: row[Columns.LOGIN_NAME],
          designation,
          isTeamLeader
        };
      }
    }

    return { success: false };
  } catch (e) {
    Logger.log('processLogin ERROR: ' + e.toString());
    return { success: false };
  }
}

/**
 * Returns a deduped list of participants for a given staff login.
 * Checks:
 *  • Unconfirmed shifts: STAFF_NAME → PARTICIPANT
 *  • Confirmed shifts:   CONF_STAFF → CONF_PARTICIPANT
 *  • Static roster map:  column I (staff) → column H (participant)
 */
function getParticipantsForUser(loginName) {
  const want = loginName.toString().trim().toLowerCase();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues();
  
  const parts = new Set();
  
  rows.forEach(r => {
    // 1) unconfirmed shifts
    const staffRaw = (r[Columns.STAFF_NAME]   || '').toString().trim().toLowerCase();
    const partRaw  = (r[Columns.PARTICIPANT]  || '').toString().trim();
    if (staffRaw === want && partRaw) parts.add(partRaw);
    
    // 2) confirmed shifts
    const confRaw  = (r[Columns.CONF_STAFF]      || '').toString().trim().toLowerCase();
    const partC    = (r[Columns.CONF_PARTICIPANT]|| '').toString().trim();
    if (confRaw === want && partC) parts.add(partC);
    
    // 3) static roster mapping: column I (index 8) = staff, H (index 7) = participant
    const rosterStaff = (r[8] || '').toString().trim().toLowerCase();
    const rosterPart  = (r[7] || '').toString().trim();
    if (rosterStaff === want && rosterPart) parts.add(rosterPart);
  });
  
  // return as array, no empties
  return Array.from(parts).filter(p => p);
}

function _appendShiftNote(date, staff, participant, note, imageUrl) {
  const sheet       = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const numCols     = sheet.getLastColumn();
  const snDateCol   = Columns.SN_DATE + 1;        // 1-based
  const startRow    = 2;
  const existing    = sheet.getRange(startRow, snDateCol, sheet.getLastRow() - 1, 1)
                           .getValues()
                           .flat();
  // find first blank SN_DATE
  const blankIndex  = existing.findIndex(v => !v);
  const targetRow   = blankIndex >= 0
    ? startRow + blankIndex
    : sheet.getLastRow() + 1;

  // build and write row
  const rowVals = Array(numCols).fill('');
  rowVals[Columns.SN_DATE]        = date;
  rowVals[Columns.SN_STAFF]       = staff;
  rowVals[Columns.SN_PARTICIPANT] = participant;
  rowVals[Columns.SN_NOTE]        = note;
  rowVals[Columns.SN_IMAGE]       = imageUrl;
  sheet.getRange(targetRow, 1, 1, numCols).setValues([rowVals]);

  // re-compute lastRow and sort only K→O
  const lastRow     = sheet.getLastRow();
  const notesStart  = startRow;
  const notesNum    = lastRow - notesStart + 1;
  const notesCol    = snDateCol;
  const notesWidth  = Columns.SN_IMAGE - Columns.SN_DATE + 1;

  sheet
    .getRange(notesStart, notesCol, notesNum, notesWidth)
    .sort({ column: notesCol, ascending: false });
}



function saveShiftNoteWithImages(date, staff, participant, note, filenames, base64List) {
  _clearRowCache();
  const folder = DriveApp.getFolderById('143hgHqYknhvqQqy8eZti2v_hXatXA3wg');

  const publicUrls = filenames.map((name, i) => {
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64List[i]),
      MimeType.JPEG,
      name
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/uc?export=view&id=' + file.getId();
  });

  _appendShiftNote(date, staff, participant, note, publicUrls.join(','));
}

// ── On every deployment or sheet‐reset, call this once to backfill IDs ─────────

function addShift(date, startTime, endTime, participant, staffName, duty, existingShifts) {
  _clearRowCache();

  // Fallback to sheet read if not passed
  const shifts = Array.isArray(existingShifts) ? existingShifts : getAllShifts();

  // Overlap check
  const start = toMinutes(startTime);
  const end   = toMinutes(endTime);
  const overlapping = shifts.find(s =>
    s.staffName === staffName &&
    s.date === date &&
    (
      (start >= toMinutes(s.start) && start < toMinutes(s.end)) ||
      (end > toMinutes(s.start) && end <= toMinutes(s.end)) ||
      (start <= toMinutes(s.start) && end >= toMinutes(s.end))
    )
  );
  if (overlapping) {
    return `Overlap with existing shift for ${staffName} on ${date}`;
  }

  // Write to confirmed side
  const sheet       = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const unconfWidth = Columns.PARTICIPANT + 1;
  const confCol     = Columns.CONF_DATE + 1;

  const colVals  = sheet.getRange(2, confCol, sheet.getLastRow() - 1).getValues().flat();
  const blankRow = colVals.findIndex(v => !v) + 2 || sheet.getLastRow() + 1;

  const row = Array(unconfWidth).fill('');
  row[0] = date;
  row[1] = startTime;
  row[2] = endTime;
  row[3] = duty || '';
  row[4] = staffName;
  row[5] = participant;

  sheet.getRange(blankRow, confCol, 1, unconfWidth).setValues([row]);
  sheet.getRange(blankRow, Columns.CONF_REASON + 1).setValue('*shift requested*');
}

function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + (m || 0);
}


function addShiftAndReload(dateStr, startStr, endStr, userName, participant, duty) {
  _clearRowCache();  
  // Append a new un-confirmed shift row
  addShift(dateStr, startStr, endStr, participant, userName, duty);
  // Return fresh data
  return {
    all:  getAllShifts(),
    done: getCompletedShifts(userName)
  };
}

function clearShiftNoteById(shiftId) {
  _clearRowCache();
  const sheet    = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const rows     = sheet.getDataRange().getValues();
  const ID_COL   = Columns.SHIFT_ID;
  const NOTE_COL = Columns.SN_NOTE + 1;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ID_COL] === shiftId) {
      sheet.getRange(i + 1, NOTE_COL).setValue('');
      break;
    }
  }

  return {
    all:  getAllShifts(),
    done: getCompletedShifts('')
  };
}

function deleteShiftById(shiftId) {
  _clearRowCache();
  const sheet  = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const rows   = sheet.getDataRange().getValues();
  const ID_COL = Columns.SHIFT_ID;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ID_COL] === shiftId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }

  return {
    all:  getAllShifts(),
    done: getCompletedShifts('')
  };
}

function updateShiftFieldById(shiftId, columnKey, newValue) {
  _clearRowCache();
  const sheet   = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const rows    = sheet.getDataRange().getValues();
  const ID_COL  = Columns.SHIFT_ID;
  const COL_IDX = Columns[columnKey];
  if (COL_IDX === undefined) throw new Error('Unknown column: ' + columnKey);

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ID_COL] === shiftId) {
      sheet.getRange(i + 1, COL_IDX + 1).setValue(newValue);
      break;
    }
  }

  return { all: getAllShifts() };
}


function saveShiftNoteWithImage(date, staff, participant, note, filename, base64) {
  return saveShiftNoteWithImages(
    date, staff, participant, note,
    [filename], [base64]
  );
}

function _getAllRowsCached() {
  if (!this._cachedRows) {
    this._cachedRows = sheet.getDataRange().getValues().slice(1);
  }
  return this._cachedRows;
}
function _clearRowCache() {
  this._cachedRows = null;
}
function refreshRosterData() {
  _clearRowCache();
  return _getAllRowsCached(); // triggers immediate reload
}
function _formatDate(d) {
  return Utilities.formatDate(new Date(d), TIMEZONE, DATE_FORMAT);
}
function _formatTime(t) {
  return Utilities.formatDate(new Date(t), TIMEZONE, TIME_FORMAT);
}

function getSharedData(userName) {
  const notes = getAllShiftNotes(); // reuse existing function
  const participants = getParticipantsForUser(userName); // reuse existing
  return { notes, participants };
}

function _moveShiftRow(rowIndex, reason = '') {
  // 1) Grab & clear original A–F (6 columns)
  const unconfWidth = Columns.PARTICIPANT + 1;  // PARTICIPANT is 5 → 6 cols
  const rowData     = sheet.getRange(rowIndex, 1, 1, unconfWidth).getValues()[0];
  sheet.getRange(rowIndex, 1, 1, unconfWidth).clearContent();
  const confCol1  = Columns.CONF_DATE + 1;      // zero-based → 1-based
  const colVals   = sheet.getRange(confCol1 + '2:' + confCol1).getValues().flat();
  const blankIdx  = colVals.findIndex(v => !v);
  const insertRow = blankIdx >= 0 ? blankIdx + 2 : sheet.getLastRow() + 1;

  sheet.getRange(insertRow, confCol1, 1, unconfWidth).setValues([rowData]);
  if (reason) {
    sheet.getRange(insertRow, Columns.CONF_REASON + 1).setValue(reason);
  }

  const lastRow = sheet.getLastRow();
  sheet
    .getRange(2, 1, lastRow - 1, unconfWidth)
    .sort({ column: 1, ascending: true });

  // 5) Sort Confirmed (Z2:AF) by column Z descending
  const confWidth = Columns.CONF_REASON - Columns.CONF_DATE + 1; // how many cols from Z to AF
  sheet
    .getRange(2, confCol1, lastRow - 1, confWidth)
    .sort({ column: confCol1, ascending: false });
}
// ── PUBLIC API ────────────────────────────────────────────────

function getShiftsForParticipantDate(participant, isoDate) {
  const rows = _getAllRowsCached();
  return rows
    .filter(r =>
      r[Columns.PARTICIPANT] === participant &&
      _formatDate(r[Columns.DATE]) === isoDate
    )
    .map(r => ({
      participant: r[Columns.PARTICIPANT],
      staffName:   r[Columns.STAFF_NAME],
      start:       _formatTime(r[Columns.START]),
      end:         _formatTime(r[Columns.END]),
      duty:        r[Columns.TYPE],
      note:        r[Columns.CONF_REASON] || ''
    }));
}

function confirmShiftById(shiftId, userName) {
  _clearRowCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
    const data  = sheet.getDataRange().getValues();
    const ID_COL = Columns.SHIFT_ID;
    let sourceRow = null;

    // find the row by its ID (or fallback if none)
    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const cellId = row[ID_COL];
      const fallback = 
        `${row[Columns.STAFF_NAME]}_${Utilities.formatDate(new Date(row[Columns.DATE]), TIMEZONE, DATE_FORMAT)}_${Utilities.formatDate(new Date(row[Columns.START]), TIMEZONE, TIME_FORMAT)}`;

      if ((cellId && cellId === shiftId) || (!cellId && fallback === shiftId)) {
        sourceRow = i + 1;  // sheet is 1-based
        break;
      }
    }
    if (sourceRow === null) {
      throw new Error('Shift ID not found: ' + shiftId);
    }

    // actually move it into the confirmed section (this also writes the CONF_DATE)
    _moveShiftRow(sourceRow);

    // return fresh data for the client
    return {
      all:  getAllShifts(),
      done: getCompletedShifts(userName)
    };

  } finally {
    lock.releaseLock();
  }
}

function requestAdjustmentById(shiftId, reason, userName) {
  _clearRowCache();
  const rows = sheet.getDataRange().getValues();
  let sourceRowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    const row    = rows[i];
    const cellId = row[Columns.SHIFT_ID];
    const fallback = `${row[Columns.STAFF_NAME]}_${Utilities.formatDate(new Date(row[Columns.DATE]), TIMEZONE, DATE_FORMAT)}_${Utilities.formatDate(new Date(row[Columns.START]), TIMEZONE, TIME_FORMAT)}`;
    if ((cellId && cellId === shiftId) || (!cellId && fallback === shiftId)) {
      sourceRowIndex = i + 1;
      break;
    }
  }

  if (sourceRowIndex === -1) {
    throw new Error('Shift ID not found: ' + shiftId);
  }
  _moveShiftRow(sourceRowIndex, reason);
}

function adjustShiftById(shiftId, reason, userName) {
  _clearRowCache();
  requestAdjustmentById(shiftId, reason, userName);
  return {
    all:  getAllShifts(),
    done: getCompletedShifts(userName)
  };
}

function checkManagerRole(user) {
  if (!user || user.trim().toLowerCase() !== 'manager') {
    throw new Error('Access denied');
  }
}

function getPendingShifts(loginName) {
  const want     = loginName.trim().toLowerCase();
  const now      = new Date();
  const rowsWithIdx = _getAllRowsCached().map((r, idx) => ({ r, idx }));

  return rowsWithIdx
    .filter(({r}) => {
      if ((r[Columns.STAFF_NAME] || '').toString().trim().toLowerCase() !== want) {
        return false;
      }
      // build Date object safely
      const d = new Date(r[Columns.DATE]);
      const start = new Date(r[Columns.START]);
      d.setHours(start.getHours(), start.getMinutes(), 0, 0);
      return d <= now;
    })
    .map(({r, idx}) => ({
      rowIndex:   idx + 2,
      date:       _formatDate(r[Columns.DATE]),
      start:      _formatTime(r[Columns.START]),
      end:        _formatTime(r[Columns.END]),
      duty:       r[Columns.TYPE],
      participant:r[Columns.PARTICIPANT],
      staffName:  r[Columns.STAFF_NAME]
    }));
}
// ── UPCOMING SHIFTS ────────────────────────────────────────────
function getUpcomingShifts(loginName) {
  const want       = loginName.trim().toLowerCase();
  const now        = new Date();
  const tomorrow   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  
  // include index for rowIndex
  return _getAllRowsCached()
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => {
      // staff match
      const staff = (r[Columns.STAFF_NAME] || '').toString().trim().toLowerCase();
      if (staff !== want) return false;
      
      // build full datetime from separate date & time
      const dt = new Date(r[Columns.DATE]);
      const startT = new Date(r[Columns.START]);
      dt.setHours(startT.getHours(), startT.getMinutes(), 0, 0);
      
      return dt >= tomorrow;
    })
    .map(({ r, idx }) => ({
      rowIndex:   idx + 2,
      date:       _formatDate(r[Columns.DATE]),
      start:      _formatTime(r[Columns.START]),
      end:        _formatTime(r[Columns.END]),
      duty:       r[Columns.TYPE],
      participant:r[Columns.PARTICIPANT],
      staffName:  r[Columns.STAFF_NAME]
    }));
}

function getCompletedShifts(loginName) {
  return _getAllRowsCached()
    .filter(r => r[Columns.CONF_STAFF] === loginName)
    .map(r => ({
      date:        _formatDate(r[Columns.CONF_DATE]),
      start:       _formatTime(r[Columns.CONF_START]),
      end:         _formatTime(r[Columns.CONF_END]),
      staffName:   r[Columns.CONF_STAFF],        // ← add this
      participant: r[Columns.CONF_PARTICIPANT],
      duty:        r[Columns.CONF_DUTY],
      note:        r[Columns.CONF_REASON]
    }));
}

// ── ALL SHIFT NOTES ────────────────────────────────────────────
function getAllShiftNotes() {
  return _getAllRowsCached()
    .filter(r => r[Columns.SN_STAFF])
    .map(r => ({
      date:        Utilities.formatDate(
                     new Date(r[Columns.SN_DATE]),
                     TIMEZONE,
                     "yyyy-MM-dd'T'HH:mm"
                   ),
      staff:       r[Columns.SN_STAFF],
      participant: r[Columns.SN_PARTICIPANT],
      note:        r[Columns.SN_NOTE],
      image:       r[Columns.SN_IMAGE]
    }));
}

function addConfirmedShift(shift) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('RosterDB');
  const lastRow = sheet.getLastRow() + 1;

  const row = [
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    shift.date, shift.start, shift.end,
    shift.participant, shift.staffName, shift.duty,
    '', '', '', '', '', '', '', '', '', '', '', '',
    new Date().toISOString().slice(0, 10) // CONF_DATE
  ];

  sheet.getRange(lastRow, 1, 1, row.length).setValues([row]);

  // ── Sort confirmed section (Z:AF) by CONF_DATE ↓ ─────────────────────
  const CONF_DATE_COL = 26; // column Z
  const CONF_WIDTH    = 7;  // Z→AF
  const totalRows     = sheet.getLastRow();
  sheet
    .getRange(2, CONF_DATE_COL, totalRows - 1, CONF_WIDTH)
    .sort({ column: CONF_DATE_COL, ascending: false });
}

/**
 * Returns an array of shift-objects for the given participant in the week of weekStart.
 * Each object has: { id, date, start, end, duty, staff, status }.
 * If a day has no shift, returns a blank row for that date.
 *
 * weekStart must be an ISO date string (yyyy-MM-dd) representing the Monday of that week.
 */
function getBulkShiftTemplate(participant, weekStart) {
  const sheet    = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_ROSTER);
  const allRows  = _getAllRowsCached();  // each row = array of cell-values
  const results  = [];
  const tz       = Session.getScriptTimeZone();

  const DATE_COL   = Columns.DATE;
  const START_COL  = Columns.START;
  const END_COL    = Columns.END;
  const TYPE_COL   = Columns.TYPE;
  const STAFF_COL  = Columns.STAFF_NAME;
  const PART_COL   = Columns.PARTICIPANT;
  const STATUS_COL = Columns.STATUS;
  const ID_COL     = Columns.SHIFT_ID;

  // Parse weekStart as Date (Monday at midnight)
  const monday = new Date(weekStart);
  monday.setHours(0, 0, 0, 0);

  // Build a map of existing shifts for this participant in that Monday→Sunday window
  const existingMap = {};
  allRows.forEach(r => {
    const partRaw = (r[PART_COL] || '').toString().trim();
    if (partRaw !== participant) return;
    const rowDate = new Date(r[DATE_COL]);
    rowDate.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((rowDate - monday) / (1000*60*60*24));
    if (diffDays < 0 || diffDays > 6) return;

    // Determine a stable ID: either SHIFT_ID or fallback composite
    const rawId = r[ID_COL];
    const fallbackId = 
      `${r[STAFF_COL]}_${
        Utilities.formatDate(new Date(r[DATE_COL]), tz, DATE_FORMAT)
      }_${
        Utilities.formatDate(new Date(r[START_COL]), tz, TIME_FORMAT)
      }`;
    const shiftId = (rawId && rawId.toString().trim()) ? rawId.toString() : fallbackId;

    existingMap[shiftId] = {
      id:     shiftId,
      date:   Utilities.formatDate(new Date(r[DATE_COL]), tz, DATE_FORMAT),
      start:  Utilities.formatDate(new Date(r[START_COL]), tz, TIME_FORMAT),
      end:    Utilities.formatDate(new Date(r[END_COL]), tz, TIME_FORMAT),
      duty:   r[TYPE_COL]  || 'Active Shift',
      staff:  r[STAFF_COL] || '',
      status: r[STATUS_COL]|| 'Pending'
    };
  });

  // For each day Monday → Sunday, include each existing shift or a single blank row
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const isoDate = Utilities.formatDate(d, tz, DATE_FORMAT);

    // If there are multiple existing shifts on this date, include all
    let foundAny = false;
    for (const key in existingMap) {
      if (existingMap[key].date === isoDate) {
        results.push(existingMap[key]);
        foundAny = true;
      }
    }
    if (!foundAny) {
      // No existing shift for this date → push a blank row
      results.push({
        id:     '',
        date:   isoDate,
        start:  '',
        end:    '',
        duty:   'Active Shift',
        staff:  '',
        status: 'Pending'
      });
    }
  }

  return results;
}


/**
 * Returns an array of 7 blank shift‐objects (Mon→Sun) for that week,
 * ignoring any existing data.
 * Each object: { id:'', date, start:'', end:'', duty:'', staff:'', status:'' }.
 */
function getDefaultTemplateWeek(participant, weekStart) {
  const tz      = Session.getScriptTimeZone();
  const results = [];
  const monday  = new Date(weekStart);
  monday.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const isoDate = Utilities.formatDate(d, tz, DATE_FORMAT);
    results.push({
      id:     '',
      date:   isoDate,
      start:  '',
      end:    '',
      duty:   'Active Shift',
      staff:  '',
      status: 'Pending'
    });
  }
  return results;
}


/**
 * Receives an array of shift‐objects from the client and applies changes:
 * - If id is non-empty: 
 *    • If status = 'Confirmed', calls confirmShiftById(id, userName).
 *    • Otherwise updates the existing row’s columns (date, start, end, duty, staff, status).
 * - If id is empty: appends a new row (unconfirmed) with a newly generated SHIFT_ID.
 *
 * Each `edit` object must include { id, date, start, end, duty, staff, status, participant }.
 */
function saveBulkShiftChanges(edits) {
  const sheet   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_ROSTER);
  const allRows = _getAllRowsCached();
  const tz      = Session.getScriptTimeZone();

  const idColIdx  = Columns.SHIFT_ID;
  const DATE_COL  = Columns.DATE;
  const START_COL = Columns.START;
  const END_COL   = Columns.END;
  const TYPE_COL  = Columns.TYPE;
  const STAFF_COL = Columns.STAFF_NAME;
  const PART_COL  = Columns.PARTICIPANT;
  const STAT_COL  = Columns.STATUS;

  // Build a map of shiftId → rowIndex (sheet 1-based)
  const idToRow = {};
  allRows.forEach((r, idx) => {
    const cellId = r[idColIdx];
    if (cellId && cellId.toString().trim()) {
      idToRow[cellId.toString()] = idx + 2; // +2 = header + 1-based
    } else {
      // fallback composite match
      const fallback =
        `${r[STAFF_COL]}_${
          Utilities.formatDate(new Date(r[DATE_COL]), tz, DATE_FORMAT)
        }_${
          Utilities.formatDate(new Date(r[START_COL]), tz, TIME_FORMAT)
        }`;
      idToRow[fallback] = idx + 2;
    }
  });

  edits.forEach(item => {
    const { id, date, start, end, duty, staff, status, participant } = item;
    if (id && id.trim() && idToRow[id]) {
      // Existing row: update or confirm
      const rowNum = idToRow[id];
      if (status === 'Confirmed') {
        // Move to confirmed section
        confirmShiftById(id, participant);
      } else {
        // Update existing unconfirmed row fields A–F + status
        sheet.getRange(rowNum, DATE_COL + 1).setValue(date);
        sheet.getRange(rowNum, START_COL + 1).setValue(start);
        sheet.getRange(rowNum, END_COL + 1).setValue(end);
        sheet.getRange(rowNum, TYPE_COL + 1).setValue(duty);
        sheet.getRange(rowNum, STAFF_COL + 1).setValue(staff);
        sheet.getRange(rowNum, STAT_COL + 1).setValue(status);
      }
    } else {
      // New shift: append to unconfirmed section with a generated UUID
      const nextRow = sheet.getLastRow() + 1;
      const newId   = Utilities.getUuid();
      const fullRow = Array(sheet.getLastColumn()).fill('');
      fullRow[DATE_COL]        = date;
      fullRow[START_COL]       = start;
      fullRow[END_COL]         = end;
      fullRow[TYPE_COL]        = duty;
      fullRow[STAFF_COL]       = staff;
      fullRow[PART_COL]        = participant;
      fullRow[STAT_COL]        = status;
      fullRow[idColIdx]        = newId;
      sheet.getRange(nextRow, 1, 1, fullRow.length).setValues([fullRow]);
    }
  });

  _clearRowCache();
}


/**
 * Returns a list of participants the current TL can manage.
 * The client passes tlName (loginName).
 */
function getParticipantsForCurrentTL(tlName) {
  return getParticipantsForUser(tlName);
}


/**
 * Moves an existing shift row into the confirmed section, preserving date/time metadata.
 * (This duplicates your existing confirmShiftById logic.)
 */
function confirmShiftById(shiftId, userName) {
  _clearRowCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
    const data  = sheet.getDataRange().getValues();
    const ID_COL = Columns.SHIFT_ID;
    let sourceRow = null;

    // Find the row by SHIFT_ID or fallback composite
    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const cellId = row[ID_COL];
      const fallback = 
        `${row[Columns.STAFF_NAME]}_${
          Utilities.formatDate(new Date(row[Columns.DATE]), Session.getScriptTimeZone(), DATE_FORMAT)
        }_${
          Utilities.formatDate(new Date(row[Columns.START]), Session.getScriptTimeZone(), TIME_FORMAT)
        }`;
      if ((cellId && cellId === shiftId) || (!cellId && fallback === shiftId)) {
        sourceRow = i + 1; // 1-based index in sheet
        break;
      }
    }
    if (sourceRow === null) {
      throw new Error('Shift ID not found: ' + shiftId);
    }

    // Now move it (reuse your existing _moveShiftRow)
    _moveShiftRow(sourceRow);
  } finally {
    lock.releaseLock();
  }
}


/**
 * Deletes a shift row entirely by SHIFT_ID.
 */
function deleteShiftById(shiftId) {
  _clearRowCache();
  const sheet  = SpreadsheetApp.getActive().getSheetByName(SHEET_ROSTER);
  const rows   = sheet.getDataRange().getValues();
  const ID_COL = Columns.SHIFT_ID;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ID_COL] === shiftId) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  _clearRowCache();
}
