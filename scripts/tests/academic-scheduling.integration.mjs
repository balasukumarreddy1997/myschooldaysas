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
  let restoreTargetCapacity;
  let restoreEnrollment;
  let restoreConsentReview;
  let restoreGuardianFlags;
  let cleanupOrgId;
  const createdEnrollmentIds = [];
  const createdIdentityUserIds = [];

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
    cleanupOrgId = orgId;

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
    const targetSection = sectionList.body.items.find((item) => item.classId !== section.classId);
    assert.ok(targetSection, "A section in another class is required for transfer and promotion checks.");
    const schoolRegistry = await api("/academic/students?limit=100&offset=0", admin);
    assert.equal(schoolRegistry.status, 200, JSON.stringify(schoolRegistry.body));
    assert.ok(schoolRegistry.body.items.length > 0);
    assert.ok(schoolRegistry.body.items.some((item) => item.classId && item.className && item.sectionName));
    const classRegistry = await api(
      `/academic/students?classId=${encodeURIComponent(section.classId)}&limit=100&offset=0`,
      admin,
    );
    assert.equal(classRegistry.status, 200, JSON.stringify(classRegistry.body));
    assert.ok(classRegistry.body.items.length > 0);
    assert.ok(classRegistry.body.items.every((item) => item.classId === section.classId));
    assert.equal((await api("/academic/students?limit=20&offset=0", teacher)).status, 400);
    assert.equal(
      (await api(`/academic/students?sectionId=${encodeURIComponent(assignment.section_id)}&classId=${encodeURIComponent(section.classId)}&limit=20`, teacher)).status,
      403,
    );
    const teacherSections = await api("/academic/sections", teacher);
    assert.equal(teacherSections.status, 200, JSON.stringify(teacherSections.body));
    const unassignedSection = sectionList.body.items.find(
      (item) => !teacherSections.body.items.some((teacherSection) => teacherSection.id === item.id),
    );
    assert.ok(unassignedSection, "A section outside the teacher's assignments is required.");
    const unassignedRoster = await api(
      `/academic/students?sectionId=${encodeURIComponent(unassignedSection.id)}&limit=20&offset=0`,
      teacher,
    );
    assert.equal(unassignedRoster.status, 200, JSON.stringify(unassignedRoster.body));
    assert.equal(unassignedRoster.body.total, 0);
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
    restoreTargetCapacity = {
      sectionId: targetSection.id,
      capacity: targetSection.capacity,
      user: admin,
    };
    restoreEnrollment = { enrollmentId: enrollment.enrollmentId, academicYear: enrollment.academicYear, user: admin };

    const capacityUpdate = await api(
      `/academic/sections/${section.id}`,
      admin,
      "PATCH",
      { capacity: temporaryCapacity },
    );
    assert.equal(capacityUpdate.status, 200, JSON.stringify(capacityUpdate.body));
    assert.equal(capacityUpdate.body.capacity, temporaryCapacity);

    const admissionsYear = `2098-${randomUUID().slice(0, 8)}`;
    const availableStudents = await api(
      `/academic/students/available?academicYear=${encodeURIComponent(admissionsYear)}&limit=2&offset=0`,
      admin,
    );
    assert.equal(availableStudents.status, 200, JSON.stringify(availableStudents.body));
    assert.equal(availableStudents.body.items.length, 2, "Two seeded students should be available for a new test year.");
    const deniedAvailableStudents = await api(
      `/academic/students/available?academicYear=${encodeURIComponent(admissionsYear)}&limit=2&offset=0`,
      teacher,
    );
    assert.equal(deniedAvailableStudents.status, 403);

    const admissionCapacity = section.studentCount + 1;
    const admissionCapacityUpdate = await api(
      `/academic/sections/${section.id}`,
      admin,
      "PATCH",
      { capacity: admissionCapacity },
    );
    assert.equal(admissionCapacityUpdate.status, 200, JSON.stringify(admissionCapacityUpdate.body));
    const concurrentAdmissions = await Promise.all(availableStudents.body.items.map((availableStudent, index) =>
      api("/academic/enrollments", admin, "POST", {
        studentId: availableStudent.id,
        sectionId: section.id,
        admissionNo: `INT-${randomUUID().replaceAll("-", "").slice(0, 16)}-${index}`,
        academicYear: admissionsYear,
      }),
    ));
    for (const response of concurrentAdmissions) {
      if (response.status === 201 && response.body.enrollmentId) {
        createdEnrollmentIds.push(response.body.enrollmentId);
      }
    }
    assert.deepEqual(concurrentAdmissions.map((response) => response.status).sort(), [201, 409]);
    const deniedEnrollment = await api("/academic/enrollments", teacher, "POST", {
      studentId: availableStudents.body.items[0].id,
      sectionId: section.id,
      admissionNo: `INT-DENIED-${randomUUID().slice(0, 8)}`,
      academicYear: admissionsYear,
    });
    assert.equal(deniedEnrollment.status, 403);

    const admissionsBatchYear = `2097-${randomUUID().slice(0, 8)}`;
    const batchSuffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const admissionBatch = {
      sectionId: section.id,
      academicYear: admissionsBatchYear,
      rows: [
        { name: "Integration New Student One", email: `new-one-${batchSuffix}@example.test`, admissionNo: `ADM-BULK-${batchSuffix}-1` },
        { name: "Integration New Student Two", email: `new-two-${batchSuffix}@example.test`, admissionNo: `ADM-BULK-${batchSuffix}-2` },
      ],
    };
    const bulkCapacityUpdate = await api(
      `/academic/sections/${section.id}`,
      admin,
      "PATCH",
      { capacity: section.studentCount + 4 },
    );
    assert.equal(bulkCapacityUpdate.status, 200, JSON.stringify(bulkCapacityUpdate.body));

    const singleAdmission = {
      sectionId: section.id,
      academicYear: admissionsBatchYear,
      rows: [{
        name: "Integration Single Admission",
        email: `single-${batchSuffix}@example.test`,
        admissionNo: `ADM-SINGLE-${batchSuffix}`,
        dateOfBirth: "2015-04-12",
        gender: "Female",
        phone: "+91 9876543210",
        address: "12 Example Road",
        bloodGroup: "O+",
        guardianName: "Integration Guardian",
        guardianEmail: `guardian-${batchSuffix}@example.test`,
        guardianPhone: "+91 9876500000",
        guardianRelationship: "Mother",
      }],
    };
    const singlePreview = await api("/academic/admissions/preview", admin, "POST", singleAdmission);
    assert.equal(singlePreview.status, 200, JSON.stringify(singlePreview.body));
    assert.equal(singlePreview.body.valid, true, JSON.stringify(singlePreview.body.errors));
    assert.equal(singlePreview.body.items[0].guardianName, "Integration Guardian");
    const invalidGuardianPreview = await api("/academic/admissions/preview", admin, "POST", {
      ...singleAdmission,
      rows: [{ ...singleAdmission.rows[0], guardianName: "", guardianEmail: undefined, guardianPhone: undefined, guardianRelationship: "Mother" }],
    });
    assert.equal(invalidGuardianPreview.status, 200, JSON.stringify(invalidGuardianPreview.body));
    assert.equal(invalidGuardianPreview.body.valid, false);
    assert.ok(invalidGuardianPreview.body.errors.some((issue) => issue.field === "guardianName"));
    const singleCreated = await api("/academic/admissions", admin, "POST", singleAdmission);
    for (const created of singleCreated.body.items ?? []) {
      if (created.id) createdIdentityUserIds.push(created.id);
    }
    assert.equal(singleCreated.status, 201, JSON.stringify(singleCreated.body));
    assert.equal(singleCreated.body.total, 1);

    const batchPreview = await api("/academic/admissions/preview", admin, "POST", admissionBatch);
    assert.equal(batchPreview.status, 200, JSON.stringify(batchPreview.body));
    assert.equal(batchPreview.body.valid, true, JSON.stringify(batchPreview.body.errors));
    assert.equal(batchPreview.body.items.length, 2);
    assert.equal(batchPreview.body.seatsAvailable, 2);
    const deniedBatchPreview = await api("/academic/admissions/preview", teacher, "POST", admissionBatch);
    assert.equal(deniedBatchPreview.status, 403);
    const deniedBatchCreate = await api("/academic/admissions", teacher, "POST", admissionBatch);
    assert.equal(deniedBatchCreate.status, 403);

    const createdAdmissions = await api("/academic/admissions", admin, "POST", admissionBatch);
    for (const created of createdAdmissions.body.items ?? []) {
      if (created.id) createdIdentityUserIds.push(created.id);
    }
    assert.equal(createdAdmissions.status, 201, JSON.stringify(createdAdmissions.body));
    assert.equal(createdAdmissions.body.total, 2);
    assert.ok(createdAdmissions.body.items.every((created) => created.temporaryPassword.length >= 12));
    assert.equal(new Set(createdAdmissions.body.items.map((created) => created.temporaryPassword)).size, 2);

    const verificationClient = await pool.connect();
    let createdAccountRows;
    try {
      await verificationClient.query("BEGIN READ ONLY");
      await verificationClient.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      createdAccountRows = (await verificationClient.query(
        `SELECT u.id, u.must_change_password, u.temporary_password_expires_at,
                array_agg(DISTINCT ur.role) AS roles, e.section_id, e.admission_no
           FROM identity.users u
           JOIN identity.user_roles ur ON ur.org_id = u.org_id AND ur.user_id = u.id
           JOIN academic.enrollments e ON e.org_id = u.org_id AND e.student_user_id = u.id
          WHERE u.org_id = $1 AND u.id = ANY($2::uuid[]) AND e.academic_year = $3
          GROUP BY u.id, e.section_id, e.admission_no`,
      [orgId, createdIdentityUserIds, admissionsBatchYear],
      )).rows;
      const profileResult = await verificationClient.query(
        `SELECT date_of_birth::text AS date_of_birth, gender, phone, address, blood_group,
                guardian_name, guardian_email, guardian_phone, guardian_relationship
           FROM identity.profiles
          WHERE org_id = $1 AND user_id = $2`,
        [orgId, singleCreated.body.items[0].id],
      );
      assert.equal(profileResult.rows.length, 1);
      assert.deepEqual(profileResult.rows[0], {
        date_of_birth: "2015-04-12",
        gender: "Female",
        phone: "+91 9876543210",
        address: "12 Example Road",
        blood_group: "O+",
        guardian_name: "Integration Guardian",
        guardian_email: `guardian-${batchSuffix}@example.test`,
        guardian_phone: "+91 9876500000",
        guardian_relationship: "Mother",
      });
      await verificationClient.query("COMMIT");
    } catch (error) {
      await verificationClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      verificationClient.release();
    }
    assert.equal(createdAccountRows.length, 3);
    assert.ok(createdAccountRows.every((created) => created.must_change_password));
    assert.ok(createdAccountRows.every((created) => created.temporary_password_expires_at));
    assert.ok(createdAccountRows.every((created) => created.roles.includes("student")));

    const singleStudentId = singleCreated.body.items[0].id;
    const profilePath = `/academic/students/${singleStudentId}/profile`;
    const loadedProfile = await api(profilePath, admin);
    assert.equal(loadedProfile.status, 200, JSON.stringify(loadedProfile.body));
    assert.equal(loadedProfile.body.profile.guardianName, "Integration Guardian");
    assert.equal(loadedProfile.body.currentEnrollment.admissionNo, singleAdmission.rows[0].admissionNo.toUpperCase());
    assert.equal((await api(profilePath, teacher)).status, 403);

    const profileUpdate = {
      dateOfBirth: "2015-04-12",
      gender: "Female",
      phone: null,
      address: "13 Updated Example Road",
      bloodGroup: "O+",
      guardianName: "Integration Guardian",
      guardianEmail: `guardian-${batchSuffix}@example.test`,
      guardianPhone: "+91 9876500000",
      guardianRelationship: "Mother",
    };
    const invalidProfileUpdate = await api(profilePath, admin, "PUT", {
      ...profileUpdate,
      guardianEmail: null,
      guardianPhone: null,
    });
    assert.equal(invalidProfileUpdate.status, 400);
    const deniedProfileUpdate = await api(profilePath, teacher, "PUT", profileUpdate);
    assert.equal(deniedProfileUpdate.status, 403);
    const savedProfile = await api(profilePath, admin, "PUT", profileUpdate);
    assert.equal(savedProfile.status, 200, JSON.stringify(savedProfile.body));
    assert.equal(savedProfile.body.profile.address, "13 Updated Example Road");
    assert.equal(savedProfile.body.profile.phone, null);
    const reloadedProfile = await api(profilePath, admin);
    assert.equal(reloadedProfile.status, 200);
    assert.equal(reloadedProfile.body.profile.address, "13 Updated Example Road");
    assert.equal(reloadedProfile.body.profile.phone, null);
    const guardianSearchUrl = `/academic/students?sectionId=${section.id}&q=${encodeURIComponent(profileUpdate.guardianEmail)}`;
    const adminRegistrySearch = await api(guardianSearchUrl, admin);
    assert.equal(adminRegistrySearch.status, 200, JSON.stringify(adminRegistrySearch.body));
    assert.ok(adminRegistrySearch.body.items.some((student) => student.id === singleStudentId));
    const teacherRegistrySearch = await api(guardianSearchUrl, teacher);
    assert.equal(teacherRegistrySearch.status, 200, JSON.stringify(teacherRegistrySearch.body));
    assert.ok(!teacherRegistrySearch.body.items.some((student) => student.id === singleStudentId));

    const transitionCapacity = targetSection.studentCount + 2;
    const targetCapacityUpdate = await api(
      `/academic/sections/${targetSection.id}`,
      admin,
      "PATCH",
      { capacity: transitionCapacity },
    );
    assert.equal(targetCapacityUpdate.status, 200, JSON.stringify(targetCapacityUpdate.body));

    const transferBody = {
      enrollmentId: loadedProfile.body.currentEnrollment.enrollmentId,
      targetSectionId: targetSection.id,
    };
    assert.equal((await api("/academic/enrollments/transfer", teacher, "POST", transferBody)).status, 403);
    const transfer = await api("/academic/enrollments/transfer", admin, "POST", transferBody);
    assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
    assert.equal(transfer.body.sectionId, targetSection.id);
    assert.equal(transfer.body.academicYear, admissionsBatchYear);
    const singleHistory = await api(`/academic/students/${singleStudentId}/enrollments`, admin);
    assert.equal(singleHistory.status, 200, JSON.stringify(singleHistory.body));
    assert.equal(singleHistory.body.items.length, 2);
    assert.ok(singleHistory.body.items.some((item) => item.endedReason === "transferred"));
    assert.equal(
      (await api(`/academic/students/${singleStudentId}/enrollments`, teacher)).status,
      403,
    );

    const sourceSections = sectionList.body.items.filter((item) => item.classId === section.classId);
    const sectionMap = Object.fromEntries(sourceSections.map((item) => [item.id, targetSection.id]));
    const promotedYear = `2100-${randomUUID().slice(0, 8)}`;
    const promotionBody = {
      fromClassId: section.classId,
      toClassId: targetSection.classId,
      fromAcademicYear: admissionsBatchYear,
      toAcademicYear: promotedYear,
      sectionMap,
    };
    const rejectedPromotion = await api("/academic/enrollments/promote", admin, "POST", promotionBody);
    assert.equal(rejectedPromotion.status, 409);
    const unchangedAfterRejectedPromotion = await api(
      `/academic/students/${createdAdmissions.body.items[0].id}/profile`,
      admin,
    );
    assert.equal(unchangedAfterRejectedPromotion.status, 200);
    assert.equal(unchangedAfterRejectedPromotion.body.currentEnrollment.academicYear, admissionsBatchYear);
    const promotionCapacityUpdate = await api(
      `/academic/sections/${targetSection.id}`,
      admin,
      "PATCH",
      { capacity: targetSection.studentCount + 10 },
    );
    assert.equal(promotionCapacityUpdate.status, 200, JSON.stringify(promotionCapacityUpdate.body));
    assert.equal((await api("/academic/enrollments/promote", teacher, "POST", promotionBody)).status, 403);
    const promotion = await api("/academic/enrollments/promote", admin, "POST", promotionBody);
    assert.equal(promotion.status, 200, JSON.stringify(promotion.body));
    assert.equal(promotion.body.promotedCount, 2);
    const promotedStudentId = createdAdmissions.body.items[0].id;
    const promotedProfile = await api(`/academic/students/${promotedStudentId}/profile`, admin);
    assert.equal(promotedProfile.status, 200, JSON.stringify(promotedProfile.body));
    assert.equal(promotedProfile.body.currentEnrollment.academicYear, promotedYear);
    assert.equal(promotedProfile.body.currentEnrollment.sectionId, targetSection.id);
    const promotedHistory = await api(`/academic/students/${promotedStudentId}/enrollments`, admin);
    assert.equal(promotedHistory.status, 200, JSON.stringify(promotedHistory.body));
    assert.ok(promotedHistory.body.items.some((item) => item.endedReason === "promoted"));
    assert.equal(promotedHistory.body.items.length, 2);

    const restoreSourceFullCapacity = await api(
      `/academic/sections/${section.id}`,
      admin,
      "PATCH",
      { capacity: section.studentCount },
    );
    assert.equal(restoreSourceFullCapacity.status, 200, JSON.stringify(restoreSourceFullCapacity.body));

    const remainingStudent = await api(
      `/academic/students/available?academicYear=${encodeURIComponent(admissionsBatchYear)}&limit=1&offset=0`,
      admin,
    );
    assert.equal(remainingStudent.status, 200, JSON.stringify(remainingStudent.body));
    assert.ok(remainingStudent.body.items.length > 0);
    const rejectedOverCapacity = await api("/academic/enrollments", admin, "POST", {
      studentId: remainingStudent.body.items[0].id,
      sectionId: section.id,
      admissionNo: `ADM-OVER-${batchSuffix}`,
      academicYear: admissionsBatchYear,
    });
    assert.equal(rejectedOverCapacity.status, 409);
    const rejectedBulkOverCapacity = await api("/academic/admissions", admin, "POST", {
      sectionId: section.id,
      academicYear: admissionsBatchYear,
      rows: [{ name: "Must Not Be Created", email: `full-${batchSuffix}@example.test`, admissionNo: `ADM-FULL-${batchSuffix}` }],
    });
    assert.equal(rejectedBulkOverCapacity.status, 409);

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

    console.log("Verified admissions, profile privacy, capacity-checked transfers and promotions with enrollment history, consent review, and timetable behavior.");
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
    if (cleanupOrgId && createdEnrollmentIds.length) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [cleanupOrgId]);
        await client.query(
          `DELETE FROM academic.enrollments
            WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [cleanupOrgId, createdEnrollmentIds],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    if (cleanupOrgId && createdIdentityUserIds.length) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [cleanupOrgId]);
        await client.query(
          `DELETE FROM identity.users
            WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [cleanupOrgId, createdIdentityUserIds],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    if (restoreTargetCapacity) {
      await api(`/academic/sections/${restoreTargetCapacity.sectionId}`, restoreTargetCapacity.user, "PATCH", {
        capacity: restoreTargetCapacity.capacity,
      }).catch(() => {});
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
