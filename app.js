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
        const isAdmin = groups.some(g => g.toLowerCase().includes('hr') || g.toLowerCase().includes('admin'));
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
            const isAdmin = groups.some(g => g.toLowerCase().includes('hr') || g.toLowerCase().includes('admin'));
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
        session = await fetchAuthSession();
    } catch (e) {
        // User not authenticated or session perfectly expired
        showView('login');
        return null;
    }

    const accessToken = session.tokens.accessToken.toString();

    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    };

    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`https://m5whfs5ivf.execute-api.ap-south-1.amazonaws.com/prod/users${path}`, options);

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
    users: [
        { id: 'u1', name: 'HR Admin', email: 'admin@company.com', role: 'admin' },
        { id: 'u2', name: 'Alice Smith', email: 'employee@company.com', role: 'employee', asDept: 'Engineering' },
        { id: 'u3', name: 'Bob Jones', email: 'bob@company.com', role: 'employee', asDept: 'Engineering' },
        { id: 'u4', name: 'Charlie Lee', email: 'charlie@company.com', role: 'employee', asDept: 'Marketing' },
        { id: 'u5', name: 'Diana Prince', email: 'diana@company.com', role: 'employee', asDept: 'Marketing' },
        { id: 'u6', name: 'Evan Wright', email: 'evan@company.com', role: 'employee', asDept: 'Engineering' }
    ],
    courses: [],
    assignments: [],
    certificates: [],
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
    await seedData();
    setupEventListeners();

    // Check if the user is already authenticated and has valid tokens
    const authUser = await requireAuth();
    if (authUser) {
        const isAdmin = authUser.groups.some(g => g.toLowerCase().includes('hr') || g.toLowerCase().includes('admin'));
        const role = isAdmin ? 'admin' : 'employee';
        let profile = null;
        try {
            profile = await apiCall(`/users/${authUser.userId}`);
        } catch (e) {
            console.warn("Could not load user profile from DynamoDB. Using defaults.", e);
        }

        let user = state.users.find(u => u.id === authUser.userId);
        if (!user) {
            user = {
                id: authUser.userId,
                name: profile?.name || authUser.username || 'User',
                email: authUser.username,
                role: role,
                asDept: profile?.department || profile?.asDept || 'Engineering',
                manager: profile?.manager || 'N/A',
                joiningDate: profile?.joiningDate || 'N/A',
                employmentType: profile?.employmentType || 'Full-time'
            };
            state.users.push(user);
        } else {
            user.role = role;
            if (profile) {
                user.name = profile.name || user.name;
                user.asDept = profile.department || profile.asDept || user.asDept;
            }
        }
        state.currentUser = user;

        if (role === 'admin') {
            if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname === '') {
                showView('admin');
            }
        } else {
            if (window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname === '') {
                showView('employee');
            }
        }
    } else {
        if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/' && window.location.pathname !== '') {
            window.location.href = '/index.html';
        } else {
            showView('login');
        }
    }
}

// Seed Data helper
async function seedData() {
    console.log("Seeding data...");

    // Hash answers for initial courses
    const q1aA = await hashString("Amazon Web Services");
    const q1aB = await hashString("A cloud platform");

    const course1 = {
        id: 'c1',
        title: 'AWS Fundamentals',
        description: 'Introduction to Core AWS Services.',
        videoUrl: 'https://www.youtube.com/embed/jZzJSQEqr0A', // Placeholder embed
        passingScore: 50,
        roles: ['Engineering'],
        questions: [
            { id: 'q1', text: 'What does AWS stand for?', options: ['Amazon Web Services', 'Amazon Web Solutions', 'Advanced Web System', 'Automated Web Services'], answerHash: await hashString('Amazon Web Services') },
            { id: 'q2', text: 'Which service provides virtual servers?', options: ['S3', 'EC2', 'RDS', 'Lambda'], answerHash: await hashString('EC2') }
        ]
    };

    const course2 = {
        id: 'c2',
        title: 'Data Privacy Basics',
        description: 'Essential facts about GDPR and PII handling.',
        videoUrl: 'https://www.youtube.com/embed/PZ5Xf4zOf3w',
        passingScore: 66,
        roles: ['Engineering', 'Marketing'],
        questions: [
            { id: 'q3', text: 'What is PII?', options: ['Personally Identifiable Information', 'Public Internet Interface', 'Private Internal IP', 'Program Instruction Index'], answerHash: await hashString('Personally Identifiable Information') },
            { id: 'q4', text: 'Does GDPR apply outside Europe?', options: ['Yes, if processing EU residents data', 'No, never', 'Only for tech companies', 'Only for banks'], answerHash: await hashString('Yes, if processing EU residents data') },
            { id: 'q5', text: 'Who owns consumer data?', options: ['The consumer', 'The company', 'The government', 'The IT Department'], answerHash: await hashString('The consumer') }
        ]
    };

    const course3 = {
        id: 'c3',
        title: 'Leadership 101',
        description: 'Foundations of effective team management.',
        videoUrl: 'https://www.youtube.com/embed/2lKpTWHSWg4',
        passingScore: 100,
        roles: ['Marketing'],
        questions: [
            { id: 'q6', text: 'What is active listening?', options: ['Listening and giving feedback', 'Waiting to speak', 'Interrupting often', 'Ignoring the speaker'], answerHash: await hashString('Listening and giving feedback') }
        ]
    };

    state.courses = [course1, course2, course3];

    // Seed assignments
    let twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    let nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);

    state.assignments = [
        { id: 'a1', courseId: 'c1', userId: 'u2', status: 'Passed', dueDate: nextWeek.toISOString().split('T')[0], attempts: 1, score: 100 },
        { id: 'a2', courseId: 'c2', userId: 'u2', status: 'In Progress', dueDate: nextWeek.toISOString().split('T')[0], attempts: 0 },
        { id: 'a3', courseId: 'c1', userId: 'u3', status: 'Failed', dueDate: twoDaysAgo.toISOString().split('T')[0], attempts: 3, score: 0 },
        { id: 'a4', courseId: 'c2', userId: 'u4', status: 'Not Started', dueDate: twoDaysAgo.toISOString().split('T')[0], attempts: 0 },
        { id: 'a5', courseId: 'c3', userId: 'u5', status: 'Passed', dueDate: nextWeek.toISOString().split('T')[0], attempts: 1, score: 100 }
    ];

    // Give certificates to those who passed
    state.certificates = [
        { id: 'CERT-10001', userId: 'u2', courseId: 'c1', date: new Date().toISOString().split('T')[0], employeeName: 'Alice Smith', courseTitle: 'AWS Fundamentals' },
        { id: 'CERT-10002', userId: 'u5', courseId: 'c3', date: new Date().toISOString().split('T')[0], employeeName: 'Diana Prince', courseTitle: 'Leadership 101' }
    ];
}

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

function showView(viewName) {
    Object.values(UI.views).forEach(v => v.classList.add('hidden'));
    UI.views[viewName].classList.remove('hidden');

    if (viewName === 'admin') initAdminDashboard();
    if (viewName === 'employee') initEmployeeDashboard();
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
            console.warn("Could not load user profile from DynamoDB. Using defaults.", e);
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
function initAdminDashboard() {
    renderCourseTable();
    populateAssignmentDropdowns();
    renderSkillGapDashboard();
}

function renderCourseTable() {
    UI.admin.courseTable.innerHTML = '';
    state.courses.forEach(course => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${course.title}</strong></td>
            <td>${course.description}</td>
            <td><a href="${course.videoUrl}" target="_blank">Link</a></td>
            <td>${course.passingScore}%</td>
            <td>${course.roles.join(', ')}</td>
            <td><span class="badge status-blue">${course.questions.length} Qs</span></td>
        `;
        UI.admin.courseTable.appendChild(tr);
    });
}

function populateAssignmentDropdowns() {
    UI.admin.assignCourseSelect.innerHTML = '<option value="">-- Select Course --</option>';
    state.courses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
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

function handleAssignCourse(e) {
    e.preventDefault();
    const courseId = UI.admin.assignCourseSelect.value;
    const target = UI.admin.assignTargetSelect.value;
    const dueDate = document.getElementById('assign-due-date').value;

    let targetUsers = [];
    if (target.startsWith('role:')) {
        const role = target.split(':')[1];
        if (role === 'All') {
            targetUsers = state.users.filter(u => u.role === 'employee');
        } else {
            targetUsers = state.users.filter(u => u.asDept === role);
        }
    } else if (target.startsWith('user:')) {
        const userId = target.split(':')[1];
        targetUsers.push(state.users.find(u => u.id === userId));
    }

    let count = 0;
    targetUsers.forEach(u => {
        // Prevent duplicate assignments
        if (!state.assignments.find(a => a.courseId === courseId && a.userId === u.id)) {
            state.assignments.push({
                id: 'a_' + Date.now() + Math.random().toString(36).substr(2, 5),
                courseId: courseId,
                userId: u.id,
                status: 'Not Started',
                dueDate: dueDate,
                attempts: 0
            });
            count++;
        }
    });

    showToast(`Email sent to ${count} employee(s). Course assigned.`);
    e.target.reset();
    renderSkillGapDashboard(); // Refresh matrix
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
    const roles = rolesStr.split(',').map(r => r.trim());

    const courseId = 'c_' + Date.now();
    const questions = [];

    const qItems = document.querySelectorAll('.question-builder-item');
    for (let item of qItems) {
        const text = item.querySelector('.q-text').value;
        const optA = item.querySelector('.q-opt-a').value; // marked as correct
        const optB = item.querySelector('.q-opt-b').value;
        const optC = item.querySelector('.q-opt-c').value;
        const optD = item.querySelector('.q-opt-d').value;

        const ansHash = await hashString(optA);

        // Shuffle options for display 
        // We will shuffle them on render, but store them
        const options = [optA, optB, optC, optD].filter(Boolean);

        questions.push({
            id: 'q_' + Math.random().toString(36).substr(2, 5),
            text: text,
            options: options,
            answerHash: ansHash
        });
    }

    state.courses.push({
        id: courseId, title: title, description: desc, videoUrl: url,
        passingScore: score, roles: roles, questions: questions
    });

    showToast(`Course "${title}" created successfully.`);
    closeModals();
    renderCourseTable();
    populateAssignmentDropdowns();
    renderSkillGapDashboard();
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
function initEmployeeDashboard() {
    renderMyCourses();
    renderCertificates();
    switchPanel(UI.employee.nav, UI.employee.panels, 'emp-courses');
}

function renderMyCourses() {
    UI.employee.coursesList.innerHTML = '';
    const myAssignments = state.assignments.filter(a => a.userId === state.currentUser.id);

    if (myAssignments.length === 0) {
        UI.employee.coursesList.innerHTML = '<p>No courses assigned.</p>';
        return;
    }

    const today = new Date().toISOString().split('T')[0];

    myAssignments.forEach(assignment => {
        const course = state.courses.find(c => c.id === assignment.courseId);
        if (!course) return;

        let statusClass = 'status-grey';
        if (assignment.status === 'Passed') statusClass = 'status-green';
        else if (assignment.status === 'Failed') statusClass = 'status-red';
        else if (assignment.status === 'In Progress') statusClass = 'status-blue';

        let isOverdue = (assignment.status !== 'Passed' && assignment.dueDate && assignment.dueDate < today);

        const card = document.createElement('div');
        card.className = 'course-card';
        card.innerHTML = `
            <h3>${course.title}</h3>
            <p>${course.description}</p>
            <div class="course-meta">
                <span class="badge ${statusClass}">${assignment.status}</span>
                <span class="due-date ${isOverdue ? 'overdue' : ''}">Due: ${assignment.dueDate || 'N/A'}</span>
            </div>
            ${assignment.status !== 'Passed' && assignment.attempts >= 3 ?
                `<button class="btn btn-secondary" disabled>Max Attempts Reached</button>` :
                `<button class="btn btn-primary btn-view-course" data-assignment="${assignment.id}">Go to Course</button>`
            }
        `;
        UI.employee.coursesList.appendChild(card);
    });

    document.querySelectorAll('.btn-view-course').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const asmId = e.target.dataset.assignment;
            openCourseViewer(asmId);
        });
    });
}

function openCourseViewer(assignmentId) {
    const assignment = state.assignments.find(a => a.id === assignmentId);
    if (assignment.status === 'Not Started') {
        assignment.status = 'In Progress'; // update status
        renderMyCourses(); // refresh ui side
    }
    const course = state.courses.find(c => c.id === assignment.courseId);

    UI.employee.viewerTitle.textContent = course.title;
    UI.employee.videoContainer.innerHTML = `<iframe src="${course.videoUrl}" frameborder="0" allowfullscreen></iframe>`;

    // Prepare quiz state
    state.activeQuiz = {
        assignment: assignment,
        course: course,
        currentQuestionIndex: 0,
        score: 0,
        shuffledQuestions: [...course.questions].map(q => {
            return {
                ...q,
                shuffledOptions: [...q.options].sort(() => Math.random() - 0.5) // basic shuffle
            }
        }),
        userAnswersHash: []
    };

    switchPanel(UI.employee.nav, UI.employee.panels, 'emp-course-viewer');
}

// Quiz Engine
function startQuiz() {
    if (!state.activeQuiz) return;
    document.getElementById('quiz-result-container').classList.add('hidden');
    document.getElementById('quiz-question-container').classList.remove('hidden');
    document.getElementById('btn-quiz-next').classList.remove('hidden');

    state.activeQuiz.currentQuestionIndex = 0;
    state.activeQuiz.score = 0;
    state.activeQuiz.userAnswersHash = [];

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

    // Hash the answer and store
    const hash = await hashString(selected.value);
    state.activeQuiz.userAnswersHash.push(hash);

    state.activeQuiz.currentQuestionIndex++;

    if (state.activeQuiz.currentQuestionIndex >= state.activeQuiz.shuffledQuestions.length) {
        finishQuiz();
    } else {
        renderQuestion();
    }
}

function finishQuiz() {
    document.getElementById('quiz-progress-fill').style.width = '100%';

    // Grade hashes
    let correctCount = 0;
    const questions = state.activeQuiz.shuffledQuestions;
    for (let i = 0; i < questions.length; i++) {
        if (state.activeQuiz.userAnswersHash[i] === questions[i].answerHash) {
            correctCount++;
        }
    }

    const pct = Math.round((correctCount / questions.length) * 100);
    const passed = pct >= state.activeQuiz.course.passingScore;

    state.activeQuiz.assignment.attempts++; // increment attempt tracker

    document.getElementById('quiz-question-container').classList.add('hidden');
    document.getElementById('btn-quiz-next').classList.add('hidden');

    const resContainer = document.getElementById('quiz-result-container');
    resContainer.classList.remove('hidden');

    const title = document.getElementById('quiz-result-title');
    title.textContent = passed ? 'Congratulations! You Passed.' : 'You failed the quiz.';
    title.style.color = passed ? 'var(--status-green)' : 'var(--status-red)';

    document.getElementById('quiz-result-score').innerHTML = `Score: <strong>${pct}%</strong> (Required: ${state.activeQuiz.course.passingScore}%)`;
    document.getElementById('quiz-result-attempts').innerHTML = `Attempts: ${state.activeQuiz.assignment.attempts} / 3`;

    if (passed) {
        state.activeQuiz.assignment.status = 'Passed';
        state.activeQuiz.assignment.score = pct;
        document.getElementById('btn-quiz-retake').classList.add('hidden');
        generateCertificate(state.activeQuiz.course);
        showToast("Passed! Certificate generated.");
    } else {
        if (state.activeQuiz.assignment.attempts >= 3) {
            state.activeQuiz.assignment.status = 'Failed';
            document.getElementById('btn-quiz-retake').classList.add('hidden');
            showToast("Max attempts reached.");
        } else {
            document.getElementById('btn-quiz-retake').classList.remove('hidden');
        }
        state.activeQuiz.assignment.score = pct; // Keep highest? Just keep last
    }

    renderMyCourses();
}

// Certificates
function generateCertificate(course) {
    const certId = 'CERT-' + Math.floor(100000 + Math.random() * 900000); // 6-digit
    state.certificates.push({
        id: certId,
        userId: state.currentUser.id,
        courseId: course.id,
        date: new Date().toISOString().split('T')[0],
        employeeName: state.currentUser.name,
        courseTitle: course.title
    });
    renderCertificates();
}

function renderCertificates() {
    UI.employee.certList.innerHTML = '';
    const myCerts = state.certificates.filter(c => c.userId === state.currentUser.id);

    if (myCerts.length === 0) {
        UI.employee.certList.innerHTML = '<p>No certificates earned yet.</p>';
        return;
    }

    myCerts.forEach(cert => {
        const card = document.createElement('div');
        card.className = 'cert-card';
        card.innerHTML = `
            <div class="cert-icon">🏆</div>
            <h3>${cert.courseTitle}</h3>
            <p>ID: <strong>${cert.id}</strong></p>
            <p class="text-muted">${cert.date}</p>
            <button class="btn btn-primary mt-2 btn-print-cert" data-certid="${cert.id}">View / Print</button>
        `;
        UI.employee.certList.appendChild(card);
    });

    document.querySelectorAll('.btn-print-cert').forEach(btn => {
        btn.addEventListener('click', (e) => {
            printCertificate(e.target.dataset.certid);
        });
    });
}

function printCertificate(certId) {
    const cert = state.certificates.find(c => c.id === certId);
    if (!cert) return;

    document.getElementById('print-cert-name').textContent = cert.employeeName;
    document.getElementById('print-cert-course').textContent = cert.courseTitle;
    document.getElementById('print-cert-date').textContent = cert.date;
    document.getElementById('print-cert-id').textContent = cert.id;

    window.print();
}

function verifyCertificate(e) {
    e.preventDefault();
    const id = document.getElementById('verify-cert-id').value.trim();
    const resultDiv = document.getElementById('verify-result');
    resultDiv.classList.remove('hidden');
    resultDiv.style.marginTop = '1rem';
    resultDiv.style.padding = '1rem';
    resultDiv.style.borderRadius = '0.375rem';

    const cert = state.certificates.find(c => c.id === id);
    if (cert) {
        resultDiv.style.backgroundColor = 'var(--status-green-bg)';
        resultDiv.style.color = 'var(--status-green)';
        resultDiv.innerHTML = `<strong>Valid Certificate</strong><br>Issued to: ${cert.employeeName}<br>Course: ${cert.courseTitle}<br>Date: ${cert.date}`;
    } else {
        resultDiv.style.backgroundColor = 'var(--status-red-bg)';
        resultDiv.style.color = 'var(--status-red)';
        resultDiv.innerHTML = `<strong>Invalid Certificate</strong><br>No record found for ID: ${id}`;
    }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', initApp);
