import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn, signOut, getCurrentUser, fetchAuthSession } from 'aws-amplify/auth';

Amplify.configure({
    Auth: {
        Cognito: {
            userPoolId: 'ap-south-1_OuutbLcox',       // from Cognito console
            userPoolClientId: '1ju1f0luarghoud499amanijm2',     // App client ID
            loginWith: {
                email: true
            }
        }
    }
});

async function requireAuth(requiredRole = null) {
    try {
        const user = await getCurrentUser();
        const session = await fetchAuthSession();
        const groups = session.tokens.idToken.payload['cognito:groups'] || [];

        // Role check 
        if (!groups.includes('Employee') && !groups.includes('HRAdmin')) {
            showView('login');
            return null;
        }

        const isAdmin = groups.includes('HRAdmin');
        if (requiredRole === 'admin' && !isAdmin) {
            alert('Unauthorized - HRAdmin group required');
            showView('login');
            return null;
        }

        return { userId: user.userId, username: user.username, groups };
    } catch {
        // Not signed in
        return null;
    }
}

async function login(email, password) {
    try {
        const { isSignedIn, nextStep } = await signIn({
            username: email,
            password: password
        });

        if (nextStep.signInStep === 'DONE') {
            // Get the JWT tokens
            const session = await fetchAuthSession();
            const idToken = session.tokens.idToken.toString();
            const accessToken = session.tokens.accessToken.toString();

            // Store in sessionStorage (clears when tab closes)
            // Never use localStorage for tokens — persists after browser close
            sessionStorage.setItem('idToken', idToken);
            sessionStorage.setItem('accessToken', accessToken);

            // Extract user role from IdToken claims
            const claims = session.tokens.idToken.payload;
            const groups = claims['cognito:groups'] || [];

            if (!groups.includes('Employee') && !groups.includes('HRAdmin')) {
                throw new Error("Login failed: You must be assigned to the 'Employee' or 'HRAdmin' group in Cognito.");
            }

            const isAdmin = groups.includes('HRAdmin');
            const role = isAdmin ? 'admin' : 'employee';

            return { success: true, role, userId: claims.sub };
        }

        // Handle MFA or new password required
        if (nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
            return { success: false, requiresNewPassword: true };
        }

    } catch (error) {
        console.error('AWS Cognito login error:', error);
        if (error.name === 'NotAuthorizedException') {
            return { success: false, message: 'Incorrect email or password' };
        }
        if (error.name === 'UserNotConfirmedException') {
            return { success: false, message: 'Please verify your email first' };
        }

        // Convert error to a string if it doesn't have a message property
        let errorMsg = error.message || String(error);
        if (typeof error === 'object') {
            try { errorMsg = errorMsg + " - " + JSON.stringify(error); } catch (e) { }
        }

        return { success: false, message: errorMsg };
    }
}

async function apiCall(path, method = 'GET', body = null) {
    let session;
    try {
        session = await fetchAuthSession({ forceRefresh: true });
    } catch (e) {
        // User not authenticated or session perfectly expired
        showView('login');
        return null;
    }

    if (!session.tokens) {
        showView('login');
        return null;
    }

    const idToken = session.tokens.idToken.toString();

    const options = {
        method,
        headers: {
            'Authorization': idToken,
            'Content-Type': 'application/json'
        }
    };

    if (body) options.body = JSON.stringify(body);

    // The Cognito/Users API Gateway you already pasted
    const USERS_API_BASE_URL = 'https://m5whfs5ivf.execute-api.ap-south-1.amazonaws.com/prod'; 
    // TODO: Paste your new Serverless LMS (Courses & Quizzes) API Gateway URL below
    const LMS_API_BASE_URL = 'https://yxa4h8pija.execute-api.ap-south-1.amazonaws.com/backend'; // Replace this line!

    // Route requests to the correct API Gateway
    const baseUrl = path.startsWith('/users') ? USERS_API_BASE_URL : LMS_API_BASE_URL;
    const res = await fetch(`${baseUrl}${path}`, options);

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
    }

    const resText = await res.text();
    return resText ? JSON.parse(resText) : {};
}

// Utility: SHA-256 Hash
async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Global State
let state = {
    currentUser: null,
    users: [],
    courses: [],
    assignments: [],
    certificates: [],
    employeeDashboard: null,
    activeQuiz: null // For employee taking a quiz
};

// UI Elements mapping
const UI = {
    views: {
        login: document.getElementById('login-view'),
        admin: document.getElementById('hr-admin-view'),
        employee: document.getElementById('employee-view')
    },
    toast: document.getElementById('toast'),
    // Admin
    admin: {
        panels: {
            courses: document.getElementById('admin-courses'),
            assignments: document.getElementById('admin-assignments'),
            skillGap: document.getElementById('admin-skill-gap')
        },
        nav: document.querySelectorAll('#hr-admin-view .nav-item'),
        userName: document.getElementById('hr-user-name'),
        courseTable: document.getElementById('course-table-body'),
        assignCourseSelect: document.getElementById('assign-course'),
        assignTargetSelect: document.getElementById('assign-target'),
        matrixTable: document.getElementById('skill-matrix-table'),
        matrixSummary: document.getElementById('skill-matrix-summary')
    },
    // Employee
    employee: {
        panels: {
            courses: document.getElementById('emp-courses'),
            viewer: document.getElementById('emp-course-viewer'),
            quiz: document.getElementById('emp-quiz-engine'),
            certificates: document.getElementById('emp-certificates')
        },
        nav: document.querySelectorAll('#employee-view .nav-item'),
        userName: document.getElementById('emp-user-name'),
        coursesList: document.getElementById('my-courses-list'),
        videoContainer: document.getElementById('video-container'),
        viewerTitle: document.getElementById('viewer-course-title'),
        certList: document.getElementById('certificate-list'),
        verifyResult: document.getElementById('verify-result')
    },
    modals: {
        createCourse: document.getElementById('create-course-modal')
    }
};

// Application Initialization
async function initApp() {
    setupEventListeners();

    // Check if already authenticated
    try {
        const session = await fetchAuthSession({ forceRefresh: true });

        // If no tokens, just show login
        if (!session.tokens) {
            showView('login');
            return;
        }

        const authUser = await requireAuth();
        if (!authUser) {
            showView('login');
            return;
        }

        // Only call API if we have a confirmed valid session
        const isAdmin = authUser.groups.includes('HRAdmin');
        const role = isAdmin ? 'admin' : 'employee';

        try {
            const profile = await apiCall(`/users/${authUser.userId}`);
            // profile loaded successfully
            setupUserState(authUser, profile, role);
        } catch (e) {
            if (e.message.includes('404')) {
                // User not in DynamoDB yet — create profile
                await apiCall('/users', 'POST', {
                    employee_id: authUser.userId,
                    email: authUser.username,
                    name: authUser.username,
                    role: role,
                    department: 'Unassigned'
                });
                setupUserState(authUser, null, role);
            } else {
                // Any other error — show login
                showView('login');
                return;
            }
        }

        showView(role === 'admin' ? 'admin' : 'employee');

    } catch (e) {
        // Not authenticated at all — show login
        showView('login');
    }
}

function setupUserState(authUser, profile, role) {
    let user = state.users.find(u => u.id === authUser.userId);
    if (!user) {
        user = {
            id: authUser.userId,
            name: profile?.name || authUser.username || 'User',
            email: authUser.username,
            role: role,
            asDept: profile?.department || 'Engineering'
        };
        state.users.push(user);
    } else {
        user.role = role;
        if (profile) {
            user.name = profile.name || user.name;
            user.asDept = profile.department || user.asDept;
        }
    }
    state.currentUser = user;
}

// Seed Data helper (Removed - using API)

// Event Listeners
function setupEventListeners() {
    // Login
    document.getElementById('login-form').addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('hr-logout-btn').addEventListener('click', handleLogout);
    document.getElementById('emp-logout-btn').addEventListener('click', handleLogout);

    // Navigations
    UI.admin.nav.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchPanel(UI.admin.nav, UI.admin.panels, e.target.dataset.target);
        });
    });

    UI.employee.nav.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchPanel(UI.employee.nav, UI.employee.panels, e.target.dataset.target);
        });
    });

    // Admin Events
    document.getElementById('btn-create-course').addEventListener('click', openCreateCourseModal);
    document.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', closeModals));
    document.getElementById('btn-add-question').addEventListener('click', addQuestionToBuilder);
    document.getElementById('create-course-form').addEventListener('submit', handleCreateCourse);
    document.getElementById('assignment-form').addEventListener('submit', handleAssignCourse);

    // Employee Events
    document.getElementById('btn-back-courses').addEventListener('click', () => switchPanel(UI.employee.nav, UI.employee.panels, 'emp-courses'));
    document.getElementById('btn-take-quiz').addEventListener('click', startQuiz);
    document.getElementById('btn-quiz-next').addEventListener('click', handleNextQuestion);
    document.getElementById('btn-quiz-retake').addEventListener('click', startQuiz);
    document.getElementById('btn-quiz-finish').addEventListener('click', () => switchPanel(UI.employee.nav, UI.employee.panels, 'emp-courses'));
    document.getElementById('btn-verify-cert').addEventListener('click', verifyCertificate);
}

// Toast
function showToast(message) {
    UI.toast.textContent = message;
    UI.toast.classList.remove('hidden');
    UI.toast.classList.add('show');
    setTimeout(() => {
        UI.toast.classList.remove('show');
        setTimeout(() => UI.toast.classList.add('hidden'), 300);
    }, 3000);
}

// Navigation Helper
function switchPanel(navItems, panelsObj, targetId) {
    navItems.forEach(nav => {
        if (nav.dataset.target === targetId) nav.classList.add('active');
        else nav.classList.remove('active');
    });
    Object.values(panelsObj).forEach(panel => {
        if (panel.id === targetId) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
    });
}

async function showView(viewName) {
    Object.values(UI.views).forEach(v => v.classList.add('hidden'));
    UI.views[viewName].classList.remove('hidden');

    if (viewName === 'admin') await initAdminDashboard();
    if (viewName === 'employee') await initEmployeeDashboard();
}

// Auth
async function handleLogin(e) {
    e.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error-message');
    const btn = document.getElementById('login-btn');

    btn.disabled = true;
    btn.textContent = 'Signing in...';
    if (errorDiv) errorDiv.textContent = '';

    // Call Cognito login
    const result = await login(email, password);

    if (result.success) {
        btn.textContent = 'Verifying Profile Data...';
        let profile = null;
        try {
            profile = await apiCall(`/users/${result.userId}`);
        } catch (e) {
            console.warn("Could not load user profile from DynamoDB.", e);
            if (e.message && e.message.includes("404")) {
                try {
                    console.log("Profile doesn't exist yet - creating it");
                    await apiCall(`/users`, 'POST', {
                        employee_id: result.userId,
                        email: email,
                        name: email.split('@')[0],
                        role: result.role,
                        department: 'Unassigned'
                    });
                    profile = { department: 'Unassigned', manager: 'N/A', employmentType: 'Full-time' };
                } catch (err) {
                    console.error('Profile sync error:', err);
                }
            } else if (e.message && e.message.includes("401")) {
                console.error("Token rejected by API. Check Cognito authorizer.");
                showView('login');
                btn.disabled = false;
                btn.textContent = 'Sign in';
                return;
            }
        }

        // Map to existing mock user or create a temporary one for the UI state
        let user = state.users.find(u => u.email === email);
        if (!user) {
            user = {
                id: result.userId,
                name: profile?.name || email.split('@')[0],
                email: email,
                role: result.role,
                asDept: profile?.department || profile?.asDept || 'Engineering',
                manager: profile?.manager || 'N/A',
                joiningDate: profile?.joiningDate || 'N/A',
                employmentType: profile?.employmentType || 'Full-time'
            };
            state.users.push(user);
        } else {
            user.role = result.role; // sync role with Cognito
            if (profile) {
                user.name = profile.name || user.name;
                user.asDept = profile.department || profile.asDept || user.asDept;
            }
        }

        state.currentUser = user;
        if (errorDiv) errorDiv.textContent = '';

        // Redirect based on role
        if (result.role === 'admin') {
            showView('admin');
        } else {
            showView('employee');
        }

        btn.disabled = false;
        btn.textContent = 'Sign in';
    } else if (result.requiresNewPassword) {
        const newPassword = prompt("Your administrator requires you to change your password. Please enter a new password:");
        if (!newPassword) {
            if (errorDiv) errorDiv.textContent = 'You must enter a new password.';
            btn.disabled = false;
            btn.textContent = 'Sign in';
            return;
        }

        btn.textContent = 'Setting new password...';
        try {
            const confirmResult = await confirmSignIn({ challengeResponse: newPassword });
            if (confirmResult.nextStep.signInStep === 'DONE') {
                alert("Password updated successfully! You will now be logged into the dashboard.");
                window.location.reload();
                return;
            } else {
                if (errorDiv) errorDiv.textContent = 'Further action required. Please check Cognito configuration.';
            }
        } catch (e) {
            console.error(e);
            if (errorDiv) errorDiv.textContent = e.message || 'Failed to update password.';
        }
        btn.disabled = false;
        btn.textContent = 'Sign in';
    } else {
        if (errorDiv) errorDiv.textContent = result.message || 'Login failed.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
    }
}

async function handleLogout() {
    try {
        await signOut();
    } catch (e) {
        console.error("Sign out error", e);
    }
    sessionStorage.removeItem('idToken');
    sessionStorage.removeItem('accessToken');

    state.currentUser = null;
    window.location.href = '/index.html';
}

/* ====================================
   HR ADMIN LOGIC 
   ==================================== */
async function initAdminDashboard() {
    try {
        const res = await apiCall('/courses', 'GET');
        const rawCourses = Array.isArray(res) ? res : (res.courses || []);
        state.courses = rawCourses.map((c) => ({
            ...c,
            course_id: c?.course_id || c?.id || c?.courseId || c?.courseID,
        }));
    } catch (e) {
        console.error("Failed to fetch courses", e);
        showToast("Error loading courses");
        state.courses = [];
    }
    
    // Attempt to load users if endpoint exists
    try {
        const uRes = await apiCall('/users', 'GET');
        state.users = Array.isArray(uRes) ? uRes : (uRes.users || []);
    } catch(e) {
        console.warn("Could not load users list", e);
    }

    renderCourseTable();
    populateAssignmentDropdowns();
    renderSkillGapDashboard();
}

function renderCourseTable() {
    UI.admin.courseTable.innerHTML = '';
    state.courses.forEach(course => {
        const roleValue = course.assigned_roles ?? course.roles;
        const roleDisplay = typeof roleValue === 'string' && roleValue.trim()
            ? roleValue.trim()
            : 'All';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${course.title}</strong></td>
            <td>${course.description}</td>
            <td><a href="${course.video_url || course.videoUrl}" target="_blank">Link</a></td>
            <td>${course.passingScore}%</td>
            <td>${roleDisplay}</td>
            <td><span class="badge status-blue">${course.questions ? course.questions.length : '?'} Qs</span></td>
        `;
        UI.admin.courseTable.appendChild(tr);
    });
}

function populateAssignmentDropdowns() {
    UI.admin.assignCourseSelect.innerHTML = '<option value="">-- Select Course --</option>';
    state.courses.forEach(c => {
        if (!c.course_id) return;
        const opt = document.createElement('option');
        opt.value = c.course_id;
        opt.textContent = c.title;
        UI.admin.assignCourseSelect.appendChild(opt);
    });

    // Populate individual employees
    const empGroup = document.createElement('optgroup');
    empGroup.label = "Specific Employees";
    state.users.filter(u => u.role === 'employee').forEach(u => {
        const opt = document.createElement('option');
        opt.value = `user:${u.id}`;
        opt.textContent = `${u.name} (${u.asDept})`;
        empGroup.appendChild(opt);
    });
    UI.admin.assignTargetSelect.appendChild(empGroup);
}

async function handleAssignCourse(e) {
    e.preventDefault();
    const courseId = UI.admin.assignCourseSelect.value;
    const target = UI.admin.assignTargetSelect.value;
    const dueDate = document.getElementById('assign-due-date').value;

    if (!courseId || courseId === 'undefined') {
        showToast('Please select a valid course.');
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Assigning...';

    try {
        await apiCall(`/courses/${courseId}/assign`, 'POST', { target: target, due_date: dueDate });
        showToast(`Course assigned successfully.`);
        e.target.reset();
        await initAdminDashboard(); // Refresh matrix
    } catch(err) {
        showToast(`Assignment failed: ${err.message}`);
        console.error(err);
    }

    btn.disabled = false;
    btn.textContent = originalText;
}

// Modal handling
function openCreateCourseModal() {
    document.getElementById('create-course-form').reset();
    document.getElementById('quiz-builder-questions').innerHTML = '';
    addQuestionToBuilder(); // Add one empty question
    UI.modals.createCourse.classList.remove('hidden');
}

function closeModals() {
    UI.modals.createCourse.classList.add('hidden');
}

let builderQCount = 0;
function addQuestionToBuilder() {
    builderQCount++;
    const container = document.getElementById('quiz-builder-questions');
    const qDiv = document.createElement('div');
    qDiv.className = 'question-builder-item form-grid';
    qDiv.id = `builder-q-${builderQCount}`;

    qDiv.innerHTML = `
        <div class="input-group" style="grid-column: 1 / -1;">
            <label>Question ${builderQCount} Text</label>
            <input type="text" class="q-text" required placeholder="e.g. What is AWS?">
        </div>
        <div class="input-group">
            <label>Option A (Correct Answer)</label>
            <input type="text" class="q-opt-a" required>
        </div>
        <div class="input-group">
            <label>Option B</label>
            <input type="text" class="q-opt-b" required>
        </div>
        <div class="input-group">
            <label>Option C</label>
            <input type="text" class="q-opt-c" required>
        </div>
        <div class="input-group">
            <label>Option D</label>
            <input type="text" class="q-opt-d" required>
        </div>
        <button type="button" class="btn btn-logout btn-small" onclick="document.getElementById('${qDiv.id}').remove()">Remove</button>
    `;
    container.appendChild(qDiv);
}

async function handleCreateCourse(e) {
    e.preventDefault();
    const title = document.getElementById('new-course-title').value;
    const desc = document.getElementById('new-course-desc').value;
    const url = document.getElementById('new-course-url').value;
    const score = parseInt(document.getElementById('new-course-score').value);
    const rolesStr = document.getElementById('new-course-roles').value;
    const roles = rolesStr.trim();

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const questions = [];
    const qItems = document.querySelectorAll('.question-builder-item');
    for (let item of qItems) {
        const text = item.querySelector('.q-text').value;
        const optA = item.querySelector('.q-opt-a').value; // marked as correct
        const optB = item.querySelector('.q-opt-b').value;
        const optC = item.querySelector('.q-opt-c').value;
        const optD = item.querySelector('.q-opt-d').value;

        const options = [optA, optB, optC, optD].filter(Boolean);

        questions.push({
            text: text,
            options: options,
            correct_answer: optA
        });
    }

    try {
        const courseId = 'c-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        await apiCall('/courses', 'POST', {
            course_id: courseId,
            title: title,
            description: desc,
            video_url: url,
            passingScore: score,
            assigned_roles: roles,
            questions: questions
        });
        showToast(`Course "${title}" created successfully.`);
        closeModals();
        await initAdminDashboard(); // Refresh course list
    } catch(err) {
        showToast(`Failed to create course: ${err.message}`);
        console.error(err);
    }

    btn.disabled = false;
    btn.textContent = originalText;
}

// Skill Gap Matrix
function renderSkillGapDashboard() {
    const employees = state.users.filter(u => u.role === 'employee');
    const courses = state.courses;

    // Matrix Table
    let tableHTML = '<thead><tr><th>Employee</th>';
    courses.forEach(c => tableHTML += `<th>${c.title}</th>`);
    tableHTML += '</tr></thead><tbody>';

    const today = new Date().toISOString().split('T')[0];

    employees.forEach(emp => {
        tableHTML += `<tr><th>${emp.name}<br><small style="color:var(--text-muted);font-weight:normal">${emp.asDept}</small></th>`;
        courses.forEach(course => {
            const assignment = state.assignments.find(a => a.userId === emp.id && a.courseId === course.id);
            if (!assignment) {
                tableHTML += `<td class="cell-bg-not-started">N/A</td>`;
            } else {
                let cellClass = '';
                let isOverdue = false;
                if (assignment.status === 'Passed') cellClass = 'cell-bg-passed';
                else if (assignment.status === 'Failed') cellClass = 'cell-bg-failed';
                else if (assignment.status === 'In Progress') cellClass = 'cell-bg-in-progress';
                else cellClass = 'cell-bg-not-started';

                if (assignment.status !== 'Passed' && assignment.dueDate && assignment.dueDate < today) {
                    isOverdue = true;
                }

                tableHTML += `<td class="${cellClass} ${isOverdue ? 'overdue-cell' : ''}">
                    ${assignment.status}
                    ${isOverdue ? '<span class="overdue-badge">OVERDUE</span>' : ''}
                </td>`;
            }
        });
        tableHTML += '</tr>';
    });
    tableHTML += '</tbody>';
    UI.admin.matrixTable.innerHTML = tableHTML;

    // Summary Chart
    const depts = {};
    employees.forEach(e => {
        if (!depts[e.asDept]) depts[e.asDept] = { total: 0, passed: 0 };
    });

    state.assignments.forEach(a => {
        const emp = employees.find(e => e.id === a.userId);
        if (emp) {
            depts[emp.asDept].total++;
            if (a.status === 'Passed') depts[emp.asDept].passed++;
        }
    });

    UI.admin.matrixSummary.innerHTML = '';
    Object.keys(depts).forEach(dept => {
        const d = depts[dept];
        const pct = d.total === 0 ? 0 : Math.round((d.passed / d.total) * 100);

        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
            <div class="bar-label">${dept}</div>
            <div class="bar-track">
                <div class="bar-fill" style="width: ${pct}%"></div>
                <div class="bar-value">${pct}%</div>
            </div>
        `;
        UI.admin.matrixSummary.appendChild(row);

        // Trigger animation
        setTimeout(() => {
            row.querySelector('.bar-fill').style.width = pct + '%';
        }, 100);
    });
}

/* ====================================
   EMPLOYEE DASHBOARD LOGIC 
   ==================================== */
async function initEmployeeDashboard() {
    try {
        const dash = await apiCall(`/employees/${state.currentUser.id}/dashboard`, 'GET');
        state.employeeDashboard = dash;
        state.courses = Array.isArray(dash?.courses) ? dash.courses : [];
    } catch(e) {
        console.error("Failed to load employee courses", e);
        state.employeeDashboard = null;
        state.courses = [];
    }
    
    renderMyCourses();
    renderCertificates();
    switchPanel(UI.employee.nav, UI.employee.panels, 'emp-courses');
}

function renderMyCourses() {
    UI.employee.coursesList.innerHTML = '';
    const myCourses = state.courses || [];
    if (myCourses.length === 0) {
        UI.employee.coursesList.innerHTML = '<p>No courses assigned.</p>';
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    myCourses.forEach(course => {
        const statusRaw = (course.status || '').toString().toLowerCase();
        const statusLabel =
            statusRaw === 'passed' ? 'Passed' :
            statusRaw === 'failed' ? 'Failed' :
            statusRaw === 'not started' ? 'Not Started' :
            statusRaw === 'not_started' ? 'Not Started' :
            statusRaw === 'not-started' ? 'Not Started' :
            statusRaw === 'in progress' ? 'In Progress' :
            statusRaw === 'in_progress' ? 'In Progress' :
            statusRaw === 'in-progress' ? 'In Progress' :
            (course.status || 'Not Started');

        let statusClass = 'status-grey';
        if (statusLabel === 'Passed') statusClass = 'status-green';
        else if (statusLabel === 'Failed') statusClass = 'status-red';
        else if (statusLabel === 'In Progress') statusClass = 'status-blue';

        const dueDate = course.due_date || course.dueDate || null;
        const attempts = course.attempts ?? course.attempt_count ?? 0;
        const isOverdue = (statusLabel !== 'Passed' && dueDate && dueDate < today);

        const card = document.createElement('div');
        card.className = 'course-card';
        card.innerHTML = `
            <h3>${course.title}</h3>
            <p>${course.description}</p>
            <div class="course-meta">
                <span class="badge ${statusClass}">${statusLabel}</span>
                <span class="due-date ${isOverdue ? 'overdue' : ''}">Due: ${dueDate || 'N/A'}</span>
            </div>
            ${statusLabel !== 'Passed' && attempts >= 3 ?
                `<button class="btn btn-secondary" disabled>Max Attempts Reached</button>` :
                `<button class="btn btn-primary btn-view-course" data-course-id="${course.course_id}">Go to Course</button>`
            }
        `;
        UI.employee.coursesList.appendChild(card);
    });

    document.querySelectorAll('.btn-view-course').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const courseId = e.target.dataset.courseId;
            openCourseViewer(courseId);
        });
    });
}

function openCourseViewer(courseId) {
    const course = (state.courses || []).find(c => c.course_id === courseId);
    if (!course) return;

    UI.employee.viewerTitle.textContent = course.title;
    UI.employee.videoContainer.innerHTML = `<iframe src="${course.video_url || course.videoUrl}" frameborder="0" allowfullscreen></iframe>`;

    // Prepare quiz state
    state.activeQuiz = {
        course: course,
        currentQuestionIndex: 0,
        score: 0,
        shuffledQuestions: [],
        userAnswers: []
    };

    switchPanel(UI.employee.nav, UI.employee.panels, 'emp-course-viewer');
}

// Quiz Engine
async function startQuiz() {
    if (!state.activeQuiz) return;
    document.getElementById('quiz-result-container').classList.add('hidden');
    document.getElementById('quiz-question-container').classList.remove('hidden');
    
    const btnNext = document.getElementById('btn-quiz-next');
    btnNext.classList.remove('hidden');
    btnNext.textContent = 'Loading Questions...';
    btnNext.disabled = true;

    try {
        const res = await apiCall(`/courses/${state.activeQuiz.course.course_id}/quiz`, 'GET');
        const questions = Array.isArray(res) ? res : (res.questions || []);
        
        state.activeQuiz.shuffledQuestions = questions.map(q => ({
            ...q,
            shuffledOptions: [...(q.options || [])].sort(() => Math.random() - 0.5)
        }));
    } catch(err) {
        showToast("Failed to fetch questions");
        console.error(err);
        return;
    }

    state.activeQuiz.currentQuestionIndex = 0;
    state.activeQuiz.score = 0;
    state.activeQuiz.userAnswers = [];

    btnNext.disabled = false;
    UI.employee.panels.quiz.querySelector('#quiz-course-title').textContent = `Quiz: ${state.activeQuiz.course.title}`;

    switchPanel(UI.employee.nav, UI.employee.panels, 'emp-quiz-engine');
    renderQuestion();
}

function renderQuestion() {
    const idx = state.activeQuiz.currentQuestionIndex;
    const qObj = state.activeQuiz.shuffledQuestions[idx];
    const total = state.activeQuiz.shuffledQuestions.length;

    // progress bar
    document.getElementById('quiz-progress-fill').style.width = `${((idx) / total) * 100}%`;

    document.getElementById('quiz-question-text').textContent = `Q${idx + 1}: ${qObj.text}`;
    const optsContainer = document.getElementById('quiz-options-group');
    optsContainer.innerHTML = '';

    qObj.shuffledOptions.forEach((opt, i) => {
        const div = document.createElement('div');
        div.className = 'quiz-option';
        div.innerHTML = `
            <input type="radio" name="quiz-opt" id="opt-${i}" value="${opt}">
            <label style="flex:1; cursor:pointer;" for="opt-${i}">${opt}</label>
        `;
        div.addEventListener('click', () => {
            document.querySelectorAll('.quiz-option').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            div.querySelector('input').checked = true;
        });
        optsContainer.appendChild(div);
    });

    const btnNext = document.getElementById('btn-quiz-next');
    if (idx === total - 1) {
        btnNext.textContent = 'Submit Answers';
    } else {
        btnNext.textContent = 'Next Question';
    }
}

async function handleNextQuestion() {
    const selected = document.querySelector('input[name="quiz-opt"]:checked');
    if (!selected) {
        showToast("Please select an answer.");
        return;
    }

    const currentQ = state.activeQuiz.shuffledQuestions[state.activeQuiz.currentQuestionIndex];
    state.activeQuiz.userAnswers.push({
        question_id: currentQ.question_id || currentQ.id || currentQ.text,
        selected_answer: selected.value,
        answer: selected.value // Include both for compatibility
    });

    state.activeQuiz.currentQuestionIndex++;

    if (state.activeQuiz.currentQuestionIndex >= state.activeQuiz.shuffledQuestions.length) {
        await finishQuiz();
    } else {
        renderQuestion();
    }
}

async function finishQuiz() {
    document.getElementById('quiz-progress-fill').style.width = '100%';
    
    const btnNext = document.getElementById('btn-quiz-next');
    btnNext.disabled = true;
    btnNext.textContent = 'Submitting...';

    let passed = false;
    let score = 0;
    let attempts = 0;

    try {
        const res = await apiCall(`/courses/${state.activeQuiz.course.course_id}/quiz/submit`, 'POST', {
            employee_id: state.currentUser.id,
            answers: state.activeQuiz.userAnswers.map(a => ({
                question_id: a.question_id,
                answer: a.answer
            }))
        });
        
        passed = res.status && res.status.toLowerCase() === 'passed';
        score = res.score || 0;
        
    } catch(err) {
        showToast(`Failed to submit: ${err.message}`);
        console.error(err);
        btnNext.disabled = false;
        btnNext.textContent = 'Submit Answers';
        return;
    }

    document.getElementById('quiz-question-container').classList.add('hidden');
    btnNext.classList.add('hidden');
    btnNext.disabled = false;

    const resContainer = document.getElementById('quiz-result-container');
    resContainer.classList.remove('hidden');

    const title = document.getElementById('quiz-result-title');
    title.textContent = passed ? 'Congratulations! You Passed.' : 'You failed the quiz.';
    title.style.color = passed ? 'var(--status-green)' : 'var(--status-red)';

    document.getElementById('quiz-result-score').innerHTML = `Score: <strong>${score}%</strong>`;
    document.getElementById('quiz-result-attempts').innerHTML = `Attempts: ${attempts ? attempts : 'N/A'} / 3`;

    if (passed) {
        document.getElementById('btn-quiz-retake').classList.add('hidden');
        showToast("Passed! Certificate is being generated.");
    } else {
        document.getElementById('btn-quiz-retake').classList.remove('hidden');
    }

    await initEmployeeDashboard();
}

function renderCertificates() {
    UI.employee.certList.innerHTML = '';
    const earned = (state.courses || []).filter(c => c.cert_id && c.s3_link);
    if (earned.length === 0) {
        UI.employee.certList.innerHTML = '<p>No certificates earned yet.</p>';
        return;
    }

    earned.forEach(course => {
        const card = document.createElement('div');
        card.className = 'cert-card';
        card.innerHTML = `
            <div class="cert-icon">🏆</div>
            <h3>${course.title}</h3>
            <p>ID: <strong>${course.cert_id}</strong></p>
            <p class="text-muted">${course.due_date || ''}</p>
            <a href="${course.s3_link}" target="_blank" class="btn btn-primary mt-2">Download PDF</a>
        `;
        UI.employee.certList.appendChild(card);
    });
}

function verifyCertificate(e) {
    e.preventDefault();
    const id = document.getElementById('verify-cert-id').value.trim();
    const resultDiv = document.getElementById('verify-result');
    resultDiv.classList.remove('hidden');
    resultDiv.style.marginTop = '1rem';
    resultDiv.style.padding = '1rem';
    resultDiv.style.borderRadius = '0.375rem';

    apiCall(`/verify/${id}`, 'GET')
        .then((res) => {
            if (res?.valid) {
                const d = res.certificate_details || {};
                resultDiv.style.backgroundColor = 'var(--status-green-bg)';
                resultDiv.style.color = 'var(--status-green)';
                resultDiv.innerHTML = `<strong>Valid Certificate</strong><br>Issued to: ${d.issued_to}<br>Course: ${d.course_name}<br>Date: ${d.date_of_issue}`;
            } else {
                resultDiv.style.backgroundColor = 'var(--status-red-bg)';
                resultDiv.style.color = 'var(--status-red)';
                resultDiv.innerHTML = `<strong>Invalid Certificate</strong><br>${res?.message || `No record found for ID: ${id}`}`;
            }
        })
        .catch((err) => {
            resultDiv.style.backgroundColor = 'var(--status-red-bg)';
            resultDiv.style.color = 'var(--status-red)';
            resultDiv.innerHTML = `<strong>Verification failed</strong><br>${err.message}`;
        });
}

// Bootstrap
window.addEventListener('DOMContentLoaded', initApp);
