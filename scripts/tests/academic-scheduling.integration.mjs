import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";

const apiBase = (process.env.ACADEMIC_TEST_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const adminRoles = ["super_admin", "org_admin", "campus_admin"];
const teacherRoles = ["teacher", "class_teacher", "hod"];
const developmentSecret = "campus-live-development-jwt-secret-not-for-production";

function jwt(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    ...user,
    iss: "campus-live-identity",
    aud: "campus-live-web",
    iat: now,
    exp: now + 900,
    sub: user.id,
  })).toString("base64url");
  const content = `${header}.${payload}`;
  const signature = createHmac("sha256", process.env.JWT_SECRET ?? developmentSecret)
    .update(content)
    .digest("base64url");
  return `${content}.${signature}`;
}

async function api(path, user, method = "GET", body) {
  const response = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt(user)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

test("development DB/API: section capacity, enrollment year, and timetable room", {
  skip: process.env.RUN_ACADEMIC_INTEGRATION !== "1",
  timeout: 60_000,
}, async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL, "Load the root .env before running this integration test.");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let createdSlotId;
  let restoreCapacity;
  let restoreEnrollment;
  let restoreConsentReview;
  let restoreGuardianFlags;

  try {
    const identity = (await pool.query(`
      SELECT current_user AS role_name, role.rolsuper AS is_superuser,
             role.rolbypassrls AS bypasses_rls
        FROM pg_roles role
       WHERE role.rolname = current_user
    `)).rows[0];
    assert.equal(identity.role_name, "campus_app");
    assert.equal(identity.is_superuser, false);
    assert.equal(identity.bypasses_rls, false);

    const orgId = (await pool.query(
      "SELECT id FROM identity.organizations ORDER BY created_at LIMIT 1",
    )).rows[0]?.id;
    assert.ok(orgId, "Development seed must exist.");

    const client = await pool.connect();
    let people;
    let assignments;
    let linkedParentIds;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      people = (await client.query(
        `SELECT user_row.id, user_row.org_id AS "orgId", user_row.name, user_row.email,
                user_row.must_change_password AS "mustChangePassword",
                array_agg(role_row.role) AS roles
           FROM identity.users user_row
           JOIN identity.user_roles role_row
             ON role_row.org_id = user_row.org_id AND role_row.user_id = user_row.id
          WHERE user_row.org_id = $1 AND user_row.status = 'active'
            AND NOT user_row.must_change_password
          GROUP BY user_row.id`,
        [orgId],
      )).rows;
      assignments = (await client.query(
        `SELECT assignment.section_id, assignment.subject_id, assignment.teacher_user_id
           FROM academic.teacher_assignments assignment
          WHERE assignment.org_id = $1`,
        [orgId],
      )).rows;
      linkedParentIds = (await client.query(
        `SELECT DISTINCT guardian_user_id
           FROM identity.guardian_links
          WHERE org_id = $1`,
        [orgId],
      )).rows.map((row) => row.guardian_user_id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const admin = people.find((person) => person.roles.some((role) => adminRoles.includes(role)));
    const assignment = assignments.find((item) =>
      people.some((person) => person.id === item.teacher_user_id
        && person.roles.some((role) => teacherRoles.includes(role))),
    );
    assert.ok(admin, "A seeded administrator is required.");
    assert.ok(assignment, "A seeded teacher assignment is required.");
    const teacher = people.find((person) => person.id === assignment.teacher_user_id);
    const student = people.find((person) => person.roles.includes("student"));
    const parent = people.find((person) => person.roles.includes("parent") && linkedParentIds.includes(person.id));
    assert.ok(teacher && student && parent, "A seeded teacher, student, and linked parent are required.");

    const consentChoices = await api("/academic/consents", parent);
    assert.equal(consentChoices.status, 200, JSON.stringify(consentChoices.body));
    assert.ok(consentChoices.body.items.length > 0, "The parent must have at least one linked student.");
    const reviewStatus = await api("/academic/consents/review-status", parent);
    assert.equal(reviewStatus.status, 200, JSON.stringify(reviewStatus.body));
    assert.equal(reviewStatus.body.required, true);
    restoreConsentReview = {
      orgId,
      guardianId: parent.id,
      reviewedAt: reviewStatus.body.reviewedAt,
    };
    const deniedReviewStatus = await api("/academic/consents/review-status", admin);
    assert.equal(deniedReviewStatus.status, 403);
    const completeReview = await api("/academic/consents/review", parent, "POST");
    assert.equal(completeReview.status, 200, JSON.stringify(completeReview.body));
    assert.equal(completeReview.body.required, true);
    assert.ok(completeReview.body.reviewedAt);
    const recordingChoice = consentChoices.body.items.find((item) => item.purpose === "recording");
    assert.ok(recordingChoice);
    const unsupportedRecordingGrant = await api("/academic/consents", parent, "POST", {
      studentId: recordingChoice.studentId,
      purpose: "recording",
    });
    assert.equal(unsupportedRecordingGrant.status, 409);

    const guardianLinks = await api("/academic/guardians?limit=50&offset=0", admin);
    assert.equal(guardianLinks.status, 200, JSON.stringify(guardianLinks.body));
    const guardianLink = guardianLinks.body.items[0];
    assert.ok(guardianLink, "A seeded guardian link is required.");
    restoreGuardianFlags = {
      studentId: guardianLink.studentId,
      guardianId: guardianLink.guardianId,
      canViewLive: guardianLink.canViewLive,
      canPayFees: guardianLink.canPayFees,
      user: admin,
    };
    const updatedGuardianFlags = await api(
      `/academic/guardians/${guardianLink.studentId}/${guardianLink.guardianId}`,
      admin,
      "PATCH",
      { canViewLive: !guardianLink.canViewLive, canPayFees: guardianLink.canPayFees },
    );
    assert.equal(updatedGuardianFlags.status, 200, JSON.stringify(updatedGuardianFlags.body));
    assert.equal(updatedGuardianFlags.body.canViewLive, !guardianLink.canViewLive);
    const updatedPaymentFlag = await api(
      `/academic/guardians/${guardianLink.studentId}/${guardianLink.guardianId}`,
      admin,
      "PATCH",
      { canViewLive: !guardianLink.canViewLive, canPayFees: !guardianLink.canPayFees },
    );
    assert.equal(updatedPaymentFlag.status, 200, JSON.stringify(updatedPaymentFlag.body));
    assert.equal(updatedPaymentFlag.body.canPayFees, !guardianLink.canPayFees);
    const deniedGuardianList = await api("/academic/guardians?limit=50&offset=0", teacher);
    assert.equal(deniedGuardianList.status, 403);
    const deniedGuardianUpdate = await api(
      `/academic/guardians/${guardianLink.studentId}/${guardianLink.guardianId}`,
      teacher,
      "PATCH",
      { canViewLive: guardianLink.canViewLive, canPayFees: guardianLink.canPayFees },
    );
    assert.equal(deniedGuardianUpdate.status, 403);

    const sectionList = await api("/academic/sections", admin);
    assert.equal(sectionList.status, 200, JSON.stringify(sectionList.body));
    const section = sectionList.body.items.find((item) => item.id === assignment.section_id);
    assert.ok(section, "The teacher assignment section must be visible to the administrator.");
    const originalCapacity = section.capacity;
    const temporaryCapacity = originalCapacity === 9001 ? 9002 : 9001;

    const studentList = await api(
      `/academic/students?sectionId=${encodeURIComponent(assignment.section_id)}&limit=1&offset=0`,
      admin,
    );
    assert.equal(studentList.status, 200, JSON.stringify(studentList.body));
    const enrollment = studentList.body.items[0];
    assert.ok(enrollment?.enrollmentId && enrollment.academicYear, "A seeded enrollment is required.");
    restoreCapacity = { sectionId: section.id, capacity: originalCapacity, user: admin };
    restoreEnrollment = { enrollmentId: enrollment.enrollmentId, academicYear: enrollment.academicYear, user: admin };

    const capacityUpdate = await api(
      `/academic/sections/${section.id}`,
      admin,
      "PATCH",
      { capacity: temporaryCapacity },
    );
    assert.equal(capacityUpdate.status, 200, JSON.stringify(capacityUpdate.body));
    assert.equal(capacityUpdate.body.capacity, temporaryCapacity);

    const newAcademicYear = `2099-${randomUUID().slice(0, 8)}`;
    const yearUpdate = await api(
      `/academic/enrollments/${enrollment.enrollmentId}`,
      admin,
      "PATCH",
      { academicYear: newAcademicYear },
    );
    assert.equal(yearUpdate.status, 200, JSON.stringify(yearUpdate.body));
    assert.equal(yearUpdate.body.academicYear, newAcademicYear);

    const timetable = await api("/academic/timetable", admin);
    assert.equal(timetable.status, 200, JSON.stringify(timetable.body));
    let selectedSlot;
    for (let day = 0; day <= 6 && !selectedSlot; day += 1) {
      for (let minute = 0; minute <= 23 * 60; minute += 30) {
        const start = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const endMinute = minute + 30;
        if (endMinute >= 24 * 60) continue;
        const end = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
        const conflict = timetable.body.items.some((item) =>
          item.weekday === day
          && (item.sectionId === assignment.section_id || item.teacherId === assignment.teacher_user_id)
          && start < item.endTime
          && end > item.startTime,
        );
        if (!conflict) {
          selectedSlot = { weekday: day, startTime: start, endTime: end };
          break;
        }
      }
    }
    assert.ok(selectedSlot, "A free 30-minute timetable slot should be available in the seeded schedule.");

    const room = `Integration ${randomUUID().slice(0, 8)}`;
    const create = await api("/academic/timetable", admin, "POST", {
      sectionId: assignment.section_id,
      subjectId: assignment.subject_id,
      teacherId: assignment.teacher_user_id,
      ...selectedSlot,
      room,
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    createdSlotId = create.body.id;
    assert.equal(create.body.room, room);

    const teacherTimetable = await api("/academic/timetable", teacher);
    assert.equal(teacherTimetable.status, 200, JSON.stringify(teacherTimetable.body));
    assert.ok(teacherTimetable.body.items.some((item) => item.id === createdSlotId));

    const forbiddenCreate = await api("/academic/timetable", teacher, "POST", {
      sectionId: assignment.section_id,
      subjectId: assignment.subject_id,
      teacherId: assignment.teacher_user_id,
      ...selectedSlot,
      room: "Forbidden integration room",
    });
    assert.equal(forbiddenCreate.status, 403);

    const overlap = await api("/academic/timetable", admin, "POST", {
      sectionId: assignment.section_id,
      subjectId: assignment.subject_id,
      teacherId: assignment.teacher_user_id,
      ...selectedSlot,
      room: "Overlap should be rejected",
    });
    assert.equal(overlap.status, 409);

    const deleted = await api(`/academic/timetable/${createdSlotId}`, admin, "DELETE");
    assert.equal(deleted.status, 204);
    createdSlotId = undefined;

    console.log("Verified consent review, disabled recording consent, guardian flags, capacity/year updates, and timetable room/role/conflict behavior.");
  } finally {
    if (createdSlotId) await api(`/academic/timetable/${createdSlotId}`, restoreCapacity?.user, "DELETE").catch(() => {});
    if (restoreEnrollment) {
      await api(`/academic/enrollments/${restoreEnrollment.enrollmentId}`, restoreEnrollment.user, "PATCH", {
        academicYear: restoreEnrollment.academicYear,
      }).catch(() => {});
    }
    if (restoreCapacity) {
      await api(`/academic/sections/${restoreCapacity.sectionId}`, restoreCapacity.user, "PATCH", {
        capacity: restoreCapacity.capacity,
      }).catch(() => {});
    }
    if (restoreGuardianFlags) {
      await api(
        `/academic/guardians/${restoreGuardianFlags.studentId}/${restoreGuardianFlags.guardianId}`,
        restoreGuardianFlags.user,
        "PATCH",
        {
          canViewLive: restoreGuardianFlags.canViewLive,
          canPayFees: restoreGuardianFlags.canPayFees,
        },
      ).catch(() => {});
    }
    if (restoreConsentReview) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [restoreConsentReview.orgId]);
        if (restoreConsentReview.reviewedAt === null) {
          await client.query(
            `DELETE FROM academic.guardian_consent_reviews
              WHERE org_id = $1 AND guardian_user_id = $2`,
            [restoreConsentReview.orgId, restoreConsentReview.guardianId],
          );
        } else {
          await client.query(
            `UPDATE academic.guardian_consent_reviews
                SET reviewed_at = $3
              WHERE org_id = $1 AND guardian_user_id = $2`,
            [restoreConsentReview.orgId, restoreConsentReview.guardianId, restoreConsentReview.reviewedAt],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.end();
  }
});
