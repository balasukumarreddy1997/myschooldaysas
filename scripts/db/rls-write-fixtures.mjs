function idCase(table, columns, values) {
  const extraColumns = columns ? columns.split(",").map((column) => column.trim()) : [];
  const allColumns = ["id", "org_id", ...extraColumns];
  const placeholders = allColumns.map((_, index) => `$${index + 1}`);
  return {
    table,
    idColumn: "id",
    insertSql: `INSERT INTO ${table} (${allColumns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
    insertValues: (context) => [
      context.id,
      context.orgId,
      ...(values ? values(context) : []),
    ],
  };
}

function keyedCase({ table, columns, values, keySql, keyValues, replaceFixtureBeforeInsert = false }) {
  const allColumns = columns.split(",").map((column) => column.trim());
  const placeholders = allColumns.map((_, index) => `$${index + 1}`);
  return {
    table,
    keySql,
    keyValues,
    replaceFixtureBeforeInsert,
    insertSql: `INSERT INTO ${table} (${allColumns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING 1`,
    insertValues: values,
  };
}

const userId = (context) => context.ids["identity.users"][context.side];
const alternateUserId = (context) => context.auxiliaryIds.users[context.side];
const sectionId = (context) => context.ids["academic.sections"][context.side];
const subjectId = (context) => context.ids["academic.subjects"][context.side];
const termId = (context) => context.ids["learning.exam_terms"][context.side];
const sessionId = (context) => context.ids["live.sessions"][context.side];
const alternateSessionId = (context) => context.auxiliaryIds.sessions[context.side];
const boardId = (context) => context.ids["board.boards"][context.side];
const assignmentId = (context) => context.ids["learning.assignments"][context.side];
const examId = (context) => context.ids["learning.exams"][context.side];
const attendanceSessionId = (context) => context.ids["school.attendance_sessions"][context.side];

export const extraTenantCases = [
  idCase("identity.user_roles", "user_id, role", (context) => [
    context.isFixture ? userId(context) : alternateUserId(context),
    context.isFixture ? "campus_admin" : "student",
  ]),
  idCase("identity.guardian_links", "guardian_user_id, student_user_id, relationship", (context) => [
    userId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    "guardian",
  ]),
  idCase("academic.enrollments", "student_user_id, section_id, admission_no, academic_year", (context) => [
    context.isFixture ? userId(context) : alternateUserId(context),
    sectionId(context),
    `RLS-${context.side}-${context.id.slice(0, 8)}`,
    "2026-27",
  ]),
  idCase("academic.section_teachers", "section_id, teacher_user_id, is_class_teacher", (context) => [
    sectionId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    false,
  ]),
  idCase("academic.consents", "parent_id, student_id, purpose, granted_by", (context) => [
    userId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    "data_processing",
    userId(context),
  ]),
  idCase("academic.subjects", "code, name", (context) => [
    null,
    `RLS fixture subject ${context.side} ${context.id.slice(0, 8)}`,
  ]),
  idCase("academic.teacher_assignments", "section_id, subject_id, teacher_user_id", (context) => [
    sectionId(context),
    subjectId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
  ]),
  idCase("academic.guardian_consent_reviews", "guardian_user_id", (context) => [
    context.isFixture ? userId(context) : alternateUserId(context),
  ]),
  idCase(
    "academic.timetable_slots",
    "section_id, subject_id, teacher_user_id, weekday, start_time, end_time, room",
    (context) => [
      sectionId(context),
      subjectId(context),
      context.isFixture ? userId(context) : alternateUserId(context),
      1,
      context.isFixture ? "08:00" : "09:00",
      context.isFixture ? "08:45" : "09:45",
      "RLS fixture room",
    ],
  ),
  idCase("board.boards", "session_id, config", (context) => [
    context.isFixture ? sessionId(context) : alternateSessionId(context),
    JSON.stringify({ testFixture: true }),
  ]),
  idCase("board.ops", "board_id, seq, user_id, op", (context) => [
    boardId(context),
    context.isFixture ? 1 : 2,
    userId(context),
    JSON.stringify({ type: "rls-test", id: context.id }),
  ]),
  keyedCase({
    table: "board.draw_grants",
    columns: "org_id, board_id, user_id, can_draw",
    values: (context) => [
      context.orgId,
      boardId(context),
      context.isFixture ? userId(context) : alternateUserId(context),
      false,
    ],
    keySql: "org_id = $1 AND board_id = $2 AND user_id = $3",
    keyValues: (context) => [
      context.orgId,
      boardId(context),
      context.isFixture ? userId(context) : alternateUserId(context),
    ],
  }),
  idCase("learning.assignments", "section_id, teacher_user_id, title, due_at, max_points", (context) => [
    sectionId(context),
    userId(context),
    `RLS fixture assignment ${context.side} ${context.id.slice(0, 8)}`,
    "2026-06-01T12:00:00Z",
    100,
  ]),
  idCase("learning.assignment_submissions", "assignment_id, student_user_id, content", (context) => [
    assignmentId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    `RLS fixture submission ${context.id}`,
  ]),
  idCase(
    "learning.exams",
    "section_id, teacher_user_id, term_id, title, exam_date, max_points, subject_id",
    (context) => [
      sectionId(context),
      userId(context),
      termId(context),
      `RLS fixture exam ${context.side} ${context.id.slice(0, 8)}`,
      "2026-06-05",
      100,
      subjectId(context),
    ],
  ),
  idCase("learning.exam_marks", "exam_id, student_user_id, score, marked_by", (context) => [
    examId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    88,
    userId(context),
  ]),
  keyedCase({
    table: "learning.grade_scales",
    columns: "org_id, bands, updated_by",
    values: (context) => [
      context.orgId,
      JSON.stringify([{ min: 0, max: 100, label: "Test" }]),
      userId(context),
    ],
    keySql: "org_id = $1",
    keyValues: (context) => [context.orgId],
    replaceFixtureBeforeInsert: true,
  }),
  idCase("learning.audit_log", "actor_user_id, action, resource_type, resource_id", (context) => [
    userId(context),
    "rls.test",
    "fixture",
    context.id,
  ]),
  idCase("learning.report_card_publications", "student_user_id, section_id, term_id, published_by", (context) => [
    context.isFixture ? userId(context) : alternateUserId(context),
    sectionId(context),
    termId(context),
    userId(context),
  ]),
  idCase(
    "learning.report_card_remarks",
    "student_user_id, term_id, subject_id, remark, created_by",
    (context) => [
      context.isFixture ? userId(context) : alternateUserId(context),
      termId(context),
      context.isFixture ? null : subjectId(context),
      `RLS fixture remark ${context.id}`,
      userId(context),
    ],
  ),
  idCase("school.attendance_marks", "session_id, student_user_id, status", (context) => [
    attendanceSessionId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    "present",
  ]),
  idCase("school.attendance_audit_log", "actor_user_id, session_id, action", (context) => [
    userId(context),
    attendanceSessionId(context),
    "rls.test",
  ]),
  idCase("live.session_sections", "session_id, section_id", (context) => [
    context.isFixture ? sessionId(context) : alternateSessionId(context),
    sectionId(context),
  ]),
  idCase("live.session_attendance", "session_id, student_user_id", (context) => [
    sessionId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
  ]),
  idCase("live.participants", "session_id, user_id, participant_sid, joined_at", (context) => [
    sessionId(context),
    context.isFixture ? userId(context) : alternateUserId(context),
    `RLS-${context.id}`,
    "2026-01-01T09:00:00Z",
  ]),
  keyedCase({
    table: "live.webhook_events",
    columns: "org_id, event_id",
    values: (context) => [context.orgId, context.id],
    keySql: "org_id = $1 AND event_id = $2",
    keyValues: (context) => [context.orgId, context.id],
  }),
  idCase("registry.admission_enquiries", "child_name, class_applying, guardian_name, guardian_phone", (context) => [
    `RLS enquiry child ${context.side} ${context.id.slice(0, 8)}`,
    "Grade 1",
    `RLS guardian ${context.side}`,
    "0000000000",
  ]),
  idCase("registry.admission_activity", "enquiry_id, action, actor_id", (context) => [
    context.ids["registry.admission_enquiries"][context.side],
    "status_changed",
    userId(context),
  ]),
];
