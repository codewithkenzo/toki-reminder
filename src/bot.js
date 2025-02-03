/**
 * Discord Reminder Bot
 * A bot to manage tasks and send reminders with timezone support
 */

// Core imports
const { 
    Client, 
    GatewayIntentBits, 
    Events,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    SlashCommandBuilder,
    REST,
    Routes,
    ChannelType,
    EmbedBuilder
} = require('discord.js');
const nodeSchedule = require('node-schedule');
const moment = require('moment-timezone');
const { QuickDB } = require('quick.db');
require('dotenv').config();

// Initialize database and client
const db = new QuickDB();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences
    ]
});

// Global state management
const activeReminders = new Map();
const activeCountdowns = new Map();
const selectedDays = new Map();

// Constants
const COLORS = {
    SUCCESS: '#00ff00',
    ERROR: '#ff0000',
    WARNING: '#ffaa00',
    INFO: '#0099ff'
};

const EMOJIS = {
    CONFIRM: '✅',
    CANCEL: '❌',
    CLOCK: '⏰',
    CALENDAR: '📅',
    GLOBE: '🌍',
    SUCCESS: '✨',
    ERROR: '❌',
    CHANNEL: '📝',
    TASK: '📋',
    REMINDER: '🔔'
};

const DAYS = [
    { label: 'Mon', value: 1, emoji: '📅' },
    { label: 'Tue', value: 2, emoji: '📅' },
    { label: 'Wed', value: 3, emoji: '📅' },
    { label: 'Thu', value: 4, emoji: '📅' },
    { label: 'Fri', value: 5, emoji: '📅' },
    { label: 'Sat', value: 6, emoji: '📅' },
    { label: 'Sun', value: 0, emoji: '📅' }
];

const REGIONS = {
    'Europe': '🇪🇺',
    'Asia': '🌏',
    'America': '🌎',
    'Australia': '🦘',
    'Africa': '🌍',
    'Pacific': '🏖️'
};

// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('addtask')
        .setDescription('Start the process of adding a new task')
        .addStringOption(option =>
            option.setName('task')
                .setDescription('What task do you want to track?')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('canceltask')
        .setDescription('Cancel one of your task reminders'),
    new SlashCommandBuilder()
        .setName('settimezone')
        .setDescription('Set your timezone'),
    new SlashCommandBuilder()
        .setName('setupchannel')
        .setDescription('Choose a channel for reminders'),
    new SlashCommandBuilder()
        .setName('mytasks')
        .setDescription('View all your active tasks and reminders'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show bot commands and usage')
];

// Helper Functions
function createEmbed(title, description, color = COLORS.SUCCESS) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

function formatCountdown(targetDate) {
    const now = moment();
    const target = moment(targetDate);
    const diff = target.diff(now);

    if (diff <= 0) return "Reminder due now!";

    const duration = moment.duration(diff);
    const days = Math.floor(duration.asDays());
    const hours = duration.hours();
    const minutes = duration.minutes();
    const seconds = duration.seconds();

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}
function generateTimeOptions() {
    // Generate only hourly options (24 options)
    return Array.from({ length: 24 }, (_, hour) => {
        const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const timeString = `${hour.toString().padStart(2, '0')}:00`;
        
        return {
            label: timeString,
            value: timeString,
            description: `${hour12}:00 ${ampm}`,
            emoji: EMOJIS.CLOCK
        };
    });
}

// Improve the countdown update system
function startCountdownUpdate(message, targetDate) {
    const countdownId = `${message.guild.id}_${message.id}`;
    
    // Clear existing countdown if any
    if (activeCountdowns.has(countdownId)) {
        clearInterval(activeCountdowns.get(countdownId));
    }

    const interval = setInterval(async () => {
        try {
            const now = moment();
            const target = moment(targetDate);
            const diff = target.diff(now);

            if (diff <= 0) {
                clearInterval(interval);
                activeCountdowns.delete(countdownId);
                await message.delete().catch(() => {});
                return;
            }

            const countdown = formatCountdown(targetDate);
            const embed = message.embeds[0];
            const newEmbed = EmbedBuilder.from(embed)
                .setDescription(embed.description.replace(/Next reminder in:.*/, `Next reminder in: ${countdown}`));

            await message.edit({ embeds: [newEmbed] });
        } catch (error) {
            console.error('Error updating countdown:', error);
            clearInterval(interval);
            activeCountdowns.delete(countdownId);
        }
    }, 60000); // Update every minute instead of every second

    activeCountdowns.set(countdownId, interval);
    return interval;
}

// Add a function to format schedule descriptions better
function formatScheduleDescription(schedule, scheduleDay = null) {
    if (Array.isArray(schedule)) {
        return `Custom: ${schedule.map(d => DAYS.find(day => day.value === d).label).join(', ')}`;
    }

    switch(schedule) {
        case 'daily':
            return 'Every day';
        case 'weekly':
            return `Every ${DAYS.find(d => d.value === scheduleDay).label}`;
        case 'monthly':
            return `Monthly on day ${scheduleDay}${getOrdinalSuffix(scheduleDay)}`;
        default:
            return schedule;
    }
}

// Helper function for ordinal suffixes
function getOrdinalSuffix(day) {
    if (day > 3 && day < 21) return 'th';
    switch (day % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}



// Command Handlers
async function handleAddTask(interaction) {
    const taskName = interaction.options.getString('task');
    const userId = interaction.user.id;
    const userTimezone = await db.get(`user_${userId}.timezone`);
    
    if (!userTimezone) {
        await handleTimezoneSelection(interaction, true);
        return;
    }
    
    await showScheduleOptions(interaction, taskName);
}

async function showScheduleOptions(interaction, taskName) {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`schedule_daily_${taskName}`)
                .setLabel('Daily')
                .setEmoji(EMOJIS.CALENDAR)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_weekly_${taskName}`)
                .setLabel('Weekly')
                .setEmoji('📅')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_monthly_${taskName}`)
                .setLabel('Monthly')
                .setEmoji('📆')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`schedule_custom_${taskName}`)
                .setLabel('Custom Days')
                .setEmoji(EMOJIS.TASK)
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.reply({
        embeds: [createEmbed(
            `${EMOJIS.REMINDER} Schedule Task: ${taskName}`,
            'Choose how often you want to be reminded:'
        )],
        components: [row],
        ephemeral: true
    });
}

// Main Interaction Handler
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (interaction.isCommand()) {
            await handleCommand(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenu(interaction);
        } else if (interaction.isButton()) {
            await handleButton(interaction);
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        await handleInteractionError(interaction, error);
    }
});

// Interaction Handler Functions
async function handleCommand(interaction) {
    switch (interaction.commandName) {
        case 'addtask':
            await handleAddTask(interaction);
            break;
        case 'canceltask':
            await handleCancelTask(interaction);
            break;
        case 'settimezone':
            await handleTimezoneSelection(interaction);
            break;
        case 'setupchannel':
            await handleChannelSetup(interaction);
            break;
        case 'mytasks':
            await handleMyTasks(interaction);
            break;
        case 'help':
            await handleHelp(interaction);
            break;
    }
}

async function handleSelectMenu(interaction) {
    const [type, ...args] = interaction.customId.split('_');
    
    switch(type) {
        case 'timezone':
            await handleTimezoneChoice(interaction);
            break;
        case 'channel':
            await handleChannelChoice(interaction);
            break;
        case 'time':
            await handleTimeChoice(interaction);
            break;
        case 'cancel':
            await handleTaskCancellation(interaction);
            break;
    }
}

// Add these handlers for the mytasks buttons
async function handleTaskButton(interaction) {
    const [action, _] = interaction.customId.split('_');
    
    if (action === 'add') {
        // Simulate /addtask command
        await handleAddTask(interaction);
    } else if (action === 'remove') {
        // Simulate /canceltask command
        await handleCancelTask(interaction);
    }
}

// Update the button handler in the main interaction handler
async function handleButton(interaction) {
    const [type, ...args] = interaction.customId.split('_');
    
    try {
        switch(type) {
            case 'schedule':
                await handleScheduleSelection(interaction);
                break;
            case 'day':
                await handleDaySelection(interaction);
                break;
            case 'weekday':
                await handleWeekDaySelection(interaction);
                break;
            case 'monthday':
                await handleMonthDaySelection(interaction);
                break;
            case 'confirm':
                if (args[0] === 'days') {
                    await handleDayConfirmation(interaction);
                }
                break;
            case 'add':
            case 'remove':
                await handleTaskButton(interaction);
                break;
        }
    } catch (error) {
        console.error('Error handling button:', error);
        await handleInteractionError(interaction, error);
    }
}

async function handleScheduleSelection(interaction) {
    const [_, type, taskName] = interaction.customId.split('_');
    
    try {
        switch(type) {
            case 'custom':
                await showDaySelection(interaction, taskName);
                break;
            case 'weekly':
                await showWeekDaySelection(interaction, taskName);
                break;
            case 'monthly':
                await showMonthDaySelection(interaction, taskName);
                break;
            case 'daily':
                await showTimeSelection(interaction, 'daily', taskName);
                break;
        }
    } catch (error) {
        console.error('Error in schedule selection:', error);
        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} Error`,
                'Failed to process schedule selection. Please try again.',
                COLORS.ERROR
            )],
            components: []
        });
    }
}

async function showWeekDaySelection(interaction, taskName) {
    const dayButtons = DAYS.map(day => {
        return new ButtonBuilder()
            .setCustomId(`weekday_${day.value}_${taskName}`)
            .setLabel(day.label)
            .setStyle(ButtonStyle.Secondary);
    });

    const rows = [
        new ActionRowBuilder().addComponents(dayButtons.slice(0, 4)),
        new ActionRowBuilder().addComponents(dayButtons.slice(4))
    ];

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.CALENDAR} Select Day`,
            'Choose which day of the week for the reminder:'
        )],
        components: rows
    });
}

async function showDaySelection(interaction, taskName) {
    const dayButtons = DAYS.map(day => {
        return new ButtonBuilder()
            .setCustomId(`day_${day.value}_${taskName}`)
            .setLabel(day.label)
            .setStyle(ButtonStyle.Secondary);
    });

    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_days_${taskName}`)
        .setEmoji(EMOJIS.CONFIRM)
        .setStyle(ButtonStyle.Success);

    const rows = [
        new ActionRowBuilder().addComponents(dayButtons.slice(0, 4)),
        new ActionRowBuilder().addComponents([...dayButtons.slice(4), confirmButton])
    ];

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.CALENDAR} Select Days`,
            'Click the days when you want to be reminded.\nClick ✅ when done.'
        )],
        components: rows
    });
}

async function showTimeSelection(interaction, scheduleType, taskName, scheduleDay = null) {
    const timeOptions = generateTimeOptions();
    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`time_${scheduleType}_${taskName}${scheduleDay ? '_' + scheduleDay : ''}`)
                .setPlaceholder('Select reminder time')
                .addOptions(timeOptions)
        );

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.CLOCK} Select Time`,
            'Choose what time you want to be reminded:'
        )],
        components: [row]
    });
}



async function showMonthDaySelection(interaction, taskName) {
    // Create 5 rows of buttons for days 1-31
    const rows = [];
    for (let i = 0; i < 31; i += 7) {
        const buttons = Array.from({ length: Math.min(7, 31 - i) }, (_, index) => {
            const day = i + index + 1;
            return new ButtonBuilder()
                .setCustomId(`monthday_${day}_${taskName}`)
                .setLabel(day.toString())
                .setStyle(ButtonStyle.Secondary);
        });
        rows.push(new ActionRowBuilder().addComponents(buttons));
    }

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.CALENDAR} Select Day`,
            'Choose which day of the month for the reminder:\n' +
            '(If the day doesn\'t exist in a month, the reminder will be set to the last day of that month)'
        )],
        components: rows
    });
}

async function handleWeekDaySelection(interaction) {
    const [_, day, taskName] = interaction.customId.split('_');
    await showTimeSelection(interaction, 'weekly', taskName, parseInt(day));
}

async function handleMonthDaySelection(interaction) {
    const [_, day, taskName] = interaction.customId.split('_');
    await showTimeSelection(interaction, 'monthly', taskName, parseInt(day));
}

async function handleMyTasks(interaction) {
    const tasks = await db.get(`user_${interaction.user.id}.tasks`) || {};
    
    if (Object.keys(tasks).length === 0) {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('add_task')
                    .setLabel('Add Task')
                    .setEmoji(EMOJIS.TASK)
                    .setStyle(ButtonStyle.Primary)
            );

        await interaction.reply({
            embeds: [createEmbed(
                `${EMOJIS.TASK} Your Tasks`,
                'You have no active tasks.',
                COLORS.WARNING
            )],
            components: [row],
            ephemeral: true
        });
        return;
    }

    const taskList = Object.entries(tasks)
        .map(([taskName, task]) => {
            const reminderId = `${interaction.user.id}_${taskName}`;
            const reminder = activeReminders.get(reminderId);
            const nextReminder = reminder?.nextInvocation();
            
            let scheduleDesc;
            if (Array.isArray(task.schedule)) {
                scheduleDesc = task.schedule
                    .map(d => DAYS.find(day => day.value === d).label)
                    .join(', ');
            } else {
                scheduleDesc = task.schedule;
            }

            return `**${taskName}**\n` +
                   `${EMOJIS.CLOCK} Next reminder: ${nextReminder ? formatCountdown(nextReminder) : 'Not scheduled'}\n` +
                   `${EMOJIS.CALENDAR} Schedule: ${scheduleDesc} at ${task.time}\n`;
        })
        .join('\n');

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('add_task')
                .setLabel('Add Task')
                .setEmoji(EMOJIS.TASK)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('remove_task')
                .setLabel('Remove Task')
                .setEmoji(EMOJIS.CANCEL)
                .setStyle(ButtonStyle.Danger)
        );

    await interaction.reply({
        embeds: [createEmbed(
            `${EMOJIS.TASK} Your Tasks`,
            taskList
        )],
        components: [row],
        ephemeral: true
    });
}
async function handleCancelTask(interaction) {
    const tasks = await db.get(`user_${interaction.user.id}.tasks`) || {};
    
    if (Object.keys(tasks).length === 0) {
        await interaction.reply({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} No Tasks`,
                'You have no active tasks to cancel.',
                COLORS.WARNING
            )],
            ephemeral: true
        });
        return;
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('cancel_task')
                .setPlaceholder('Select task to cancel')
                .addOptions(
                    Object.entries(tasks).map(([taskName, task]) => {
                        let scheduleDesc;
                        if (Array.isArray(task.schedule)) {
                            scheduleDesc = `Custom: ${task.schedule
                                .map(d => DAYS.find(day => day.value === d).label)
                                .join(', ')}`;
                        } else {
                            scheduleDesc = task.schedule;
                        }
                        
                        return {
                            label: taskName,
                            value: taskName,
                            description: `${scheduleDesc} at ${task.time}`,
                            emoji: EMOJIS.TASK
                        };
                    })
                )
        );

    await interaction.reply({
        embeds: [createEmbed(
            `${EMOJIS.TASK} Cancel Task`,
            'Select which task you want to cancel:'
        )],
        components: [row],
        ephemeral: true
    });
}

async function handleTaskCancellation(interaction) {
    const taskName = interaction.values[0];
    const reminderId = `${interaction.user.id}_${taskName}`;
    const countdownId = `${interaction.user.id}_${taskName}_countdown`;

    // Cancel active reminder
    if (activeReminders.has(reminderId)) {
        activeReminders.get(reminderId).cancel();
        activeReminders.delete(reminderId);
    }

    // Clear countdown interval if exists
    if (activeCountdowns.has(countdownId)) {
        clearInterval(activeCountdowns.get(countdownId));
        activeCountdowns.delete(countdownId);
    }

    // Remove from database
    await db.delete(`user_${interaction.user.id}.tasks.${taskName}`);

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.SUCCESS} Task Cancelled`,
            `Successfully cancelled task: **${taskName}**`
        )],
        components: []
    });
}


async function handleDaySelection(interaction) {
    const [_, day, taskName] = interaction.customId.split('_');
    const currentDays = selectedDays.get(interaction.user.id) || new Set();
    
    if (currentDays.has(day)) {
        currentDays.delete(day);
    } else {
        currentDays.add(day);
    }
    
    selectedDays.set(interaction.user.id, currentDays);
    
    const dayButtons = DAYS.map(dayInfo => {
        const isSelected = currentDays.has(dayInfo.value.toString());
        return new ButtonBuilder()
            .setCustomId(`day_${dayInfo.value}_${taskName}`)
            .setLabel(dayInfo.label)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    });

    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_days_${taskName}`)
        .setEmoji(EMOJIS.CONFIRM)
        .setStyle(ButtonStyle.Success);

    const rows = [
        new ActionRowBuilder().addComponents(dayButtons.slice(0, 4)),
        new ActionRowBuilder().addComponents([...dayButtons.slice(4), confirmButton])
    ];

    await interaction.update({
        components: rows
    });
}




// Improve error handling with more specific messages
async function handleInteractionError(interaction, error) {
    let errorMessage = 'An error occurred while processing your request.';
    
    if (error.code === 50013) {
        errorMessage = 'I don\'t have permission to perform this action. Please check my role permissions.';
    } else if (error.code === 50001) {
        errorMessage = 'I don\'t have access to that channel. Please check channel permissions.';
    } else if (error.message.includes('Unknown interaction')) {
        errorMessage = 'This interaction has expired. Please try the command again.';
    }

    const response = {
        embeds: [createEmbed(
            `${EMOJIS.ERROR} Error`,
            errorMessage,
            COLORS.ERROR
        )],
        ephemeral: true
    };

    try {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(response);
        } else {
            await interaction.followUp(response);
        }
    } catch (e) {
        console.error('Error sending error message:', e);
    }
}

// Add a function to validate and clean up stale reminders
async function cleanupStaleReminders() {
    try {
        const allData = await db.all();
        for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('user_') && value.tasks) {
                const userId = key.replace('user_', '');
                for (const [taskName, task] of Object.entries(value.tasks)) {
                    const reminderId = `${userId}_${taskName}`;
                    if (!activeReminders.has(reminderId)) {
                        console.log(`Restoring missing reminder: ${taskName} for user ${userId}`);
                        await setupReminder(userId, taskName, task.schedule, task.time, task.scheduleDay);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error cleaning up stale reminders:', error);
    }
}

// Run cleanup periodically

setInterval(cleanupStaleReminders, 1000 * 60 * 60);

//
async function handleTimezoneNavigation(interaction) {
    const [_, direction, currentPage, region] = interaction.customId.split('_');
    const page = parseInt(currentPage);
    const allTimezones = moment.tz.names()
        .filter(tz => tz.startsWith(region))
        .map(tz => ({
            label: tz.split('/')[1].replace('_', ' '),
            value: tz,
            description: `Current time: ${moment().tz(tz).format('HH:mm')}`,
            emoji: EMOJIS.CLOCK
        }));

    const pages = Math.ceil(allTimezones.length / 25);
    const newPage = direction === 'next' ? page + 1 : page - 1;
    const timezonesPage = allTimezones.slice(newPage * 25, (newPage + 1) * 25);

    const rows = [];
    rows.push(new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('timezone_select')
                .setPlaceholder(`Select ${region} timezone`)
                .addOptions(timezonesPage)
        ));

    rows.push(new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`tz_prev_${newPage}_${region}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(newPage === 0),
            new ButtonBuilder()
                .setCustomId(`tz_next_${newPage}_${region}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(newPage === pages - 1)
        ));

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.GLOBE} Set Your Timezone`,
            `Select your timezone in ${region}:\nPage ${newPage + 1}/${pages}`
        )],
        components: rows
    });
}


// Task Scheduling and Reminder System

async function setupReminder(userId, taskName, scheduleType, time) {

 const reminderId = `${userId}_${taskName}`;
    if (activeReminders.has(reminderId)) {
        activeReminders.get(reminderId).cancel();
    }

    const userTimezone = await db.get(`user_${userId}.timezone`);
    const [hours, minutes] = time.split(':').map(Number);
    const rule = new nodeSchedule.RecurrenceRule();

    rule.hour = hours;
    rule.minute = minutes || 0;
    rule.tz = userTimezone;

    const now = moment().tz(userTimezone);
    let nextRun = moment().tz(userTimezone).hour(hours).minute(minutes || 0).second(0);

    if (Array.isArray(scheduleType)) {
        rule.dayOfWeek = scheduleType;
        while (!scheduleType.includes(nextRun.day())) {
            nextRun.add(1, 'day');
        }
    } else {
        switch(scheduleType) {
            case 'daily':
                if (nextRun.isBefore(now)) {
                    nextRun.add(1, 'day');
                }
                break;
            case 'weekly':
                rule.dayOfWeek = scheduleDay;
                if (nextRun.day() !== scheduleDay || nextRun.isBefore(now)) {
                    nextRun.day(scheduleDay + (nextRun.day() > scheduleDay ? 7 : 0));
                }
                break;
            case 'monthly':
                // Handle months with different lengths
                rule.date = scheduleDay;
                const adjustedDay = (month) => {
                    const daysInMonth = moment().tz(userTimezone).month(month).daysInMonth();
                    return Math.min(scheduleDay, daysInMonth);
                };
                
                let targetDay = adjustedDay(nextRun.month());
                nextRun.date(targetDay);
                
                if (nextRun.isBefore(now)) {
                    nextRun.add(1, 'month');
                    targetDay = adjustedDay(nextRun.month());
                    nextRun.date(targetDay);
                }
                break;
        }
    }
    const job = nodeSchedule.scheduleJob(rule, async () => {
        try {
            const channelId = await db.get(`user_${userId}.reminderChannel`);
            if (channelId) {
                const channel = await client.channels.fetch(channelId);
                const message = await channel.send({
                    content: `${EMOJIS.REMINDER} <@${userId}>, time for **${taskName}**!`,
                    embeds: [createEmbed(
                        `${EMOJIS.CLOCK} Task Reminder`,
                        `It's time for your ${scheduleType} task: **${taskName}**\n` +
                        `Next reminder in: ${formatCountdown(job.nextInvocation())}`
                    )],
                    allowedMentions: { users: [userId] }
                });

                startCountdownUpdate(message, job.nextInvocation());
            }
        } catch (error) {
            console.error('Failed to send reminder:', error);
        }
    });

    activeReminders.set(reminderId, job);
    
    await db.set(`user_${userId}.tasks.${taskName}`, {
        name: taskName,
        schedule: scheduleType,
        time: time,
        timezone: userTimezone,
        nextReminder: nextRun.toISOString()
    });

    return nextRun;
}

async function sendReminder(userId, taskName, nextInvocation) {
    const channelId = await db.get(`user_${userId}.reminderChannel`);
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        const task = await db.get(`user_${userId}.tasks.${taskName}`);
        
        const scheduleDesc = Array.isArray(task.schedule) 
            ? `on ${task.schedule.map(d => DAYS.find(day => day.value === d).label).join(', ')}`
            : task.schedule;

        const message = await channel.send({
            content: `${EMOJIS.REMINDER} <@${userId}>`,
            embeds: [
                createEmbed(
                    `${EMOJIS.TASK} Task Reminder: ${taskName}`,
                    `Time for your ${scheduleDesc} task!\n` +
                    `Next reminder in ${formatCountdown(nextInvocation)}`
                )
            ],
            allowedMentions: { users: [userId] }
        });

        // Start countdown for next reminder
        const countdownId = `${userId}_${taskName}_countdown`;
        if (activeCountdowns.has(countdownId)) {
            clearInterval(activeCountdowns.get(countdownId));
        }
        
        const interval = startCountdownUpdate(message, nextInvocation);
        activeCountdowns.set(countdownId, interval);
    } catch (error) {
        console.error('Error sending reminder:', error);
    }
}

async function handleTimeChoice(interaction) {
    const [_, scheduleType, taskName, customDays] = interaction.customId.split('_');
    const selectedTime = interaction.values[0];
    
    let schedule;
    if (customDays) {
        schedule = customDays.split(',').map(Number);
    } else {
        schedule = scheduleType;
    }

    try {
        const nextInvocation = await setupReminder(
            interaction.user.id,
            taskName,
            schedule,
            selectedTime
        );

        const scheduleDesc = Array.isArray(schedule)
            ? `on ${schedule.map(d => DAYS.find(day => day.value === d).label).join(', ')}`
            : schedule;

        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.SUCCESS} Task Scheduled`,
                `Task "${taskName}" has been scheduled!\n\n` +
                `🔔 Reminder: ${scheduleDesc} at ${selectedTime}\n` +
                `⏰ Next reminder in: ${formatCountdown(nextInvocation)}\n\n` +
                `Use /mytasks to view all your active tasks.`
            )],
            components: []
        });
    } catch (error) {
        console.error('Error scheduling task:', error);
        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} Scheduling Error`,
                'Failed to schedule the task. Please try again.',
                COLORS.ERROR
            )],
            components: []
        });
    }
}

async function handleDayConfirmation(interaction) {
    const [_, __, taskName] = interaction.customId.split('_');
    const selectedDaysList = Array.from(selectedDays.get(interaction.user.id) || new Set());
    
    if (selectedDaysList.length === 0) {
        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} Invalid Selection`,
                'Please select at least one day.',
                COLORS.ERROR
            )],
            components: []
        });
        return;
    }


    const timeOptions = generateTimeOptions();
    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`time_custom_${taskName}_${selectedDaysList.join(',')}`)
                .setPlaceholder('Select reminder time')
                .addOptions(timeOptions)
        );

    await interaction.update({
        embeds: [createEmbed(
            `${EMOJIS.CLOCK} Select Time`,
            'Choose what time you want to be reminded:'
        )],
        components: [row]
    });

    selectedDays.delete(interaction.user.id);
}

// Restore reminders on startup
async function restoreReminders() {
    console.log('Restoring reminders...');
    const allData = await db.all();
    
    for (const [key, value] of Object.entries(allData)) {
        if (key.startsWith('user_') && value.tasks) {
            const userId = key.replace('user_', '');
            for (const [taskName, task] of Object.entries(value.tasks)) {
                try {
                    await setupReminder(userId, taskName, task.schedule, task.time);
                    console.log(`Restored reminder: ${taskName} for user ${userId}`);
                } catch (error) {
                    console.error(`Failed to restore reminder: ${taskName} for user ${userId}`, error);
                }
            }
        }
    }
    console.log('Reminder restoration complete');
}


// Timezone Management
async function handleTimezoneSelection(interaction, isFromAddTask = false) {
    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`timezone_region${isFromAddTask ? '_addtask' : ''}`)
                .setPlaceholder('Select your region')
                .addOptions(
                    Object.entries(REGIONS).map(([region, emoji]) => ({
                        label: region,
                        value: region,
                        emoji: emoji
                    }))
                )
        );

    await interaction.reply({
        embeds: [createEmbed(
            `${EMOJIS.GLOBE} Set Your Timezone`,
            'First, select your region:'
        )],
        components: [row],
        ephemeral: true
    });
}

async function handleTimezoneChoice(interaction) {
    const [type, action] = interaction.customId.split('_');
    
    if (interaction.customId.startsWith('timezone_region')) {
        const selectedRegion = interaction.values[0];
        const allTimezones = moment.tz.names()
            .filter(tz => tz.startsWith(selectedRegion))
            .map(tz => ({
                label: tz.split('/')[1].replace('_', ' '),
                value: tz,
                description: `Current time: ${moment().tz(tz).format('HH:mm')}`,
                emoji: EMOJIS.CLOCK
            }));

        const pages = Math.ceil(allTimezones.length / 25);
        const timezonesPage = allTimezones.slice(0, 25);
        
        const rows = [];
        rows.push(new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`timezone_select${action === 'addtask' ? '_addtask' : ''}`)
                    .setPlaceholder(`Select ${selectedRegion} timezone`)
                    .addOptions(timezonesPage)
            ));

        if (pages > 1) {
            rows.push(new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`tz_prev_0_${selectedRegion}`)
                        .setLabel('◀️ Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`tz_next_0_${selectedRegion}`)
                        .setLabel('Next ▶️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(pages === 1)
                ));
        }

        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.GLOBE} Set Your Timezone`,
                `Select your timezone in ${selectedRegion}:${pages > 1 ? `\nPage 1/${pages}` : ''}`
            )],
            components: rows
        });
    } else {
        const timezone = interaction.values[0];
        await db.set(`user_${interaction.user.id}.timezone`, timezone);
        
        if (action === 'addtask') {
            // If this was from addtask, continue with task creation
            const taskName = await db.get(`user_${interaction.user.id}.pendingTask`);
            await db.delete(`user_${interaction.user.id}.pendingTask`);
            await showScheduleOptions(interaction, taskName);
        } else {
            await interaction.update({
                embeds: [createEmbed(
                    `${EMOJIS.SUCCESS} Timezone Set`,
                    `Your timezone has been set to **${timezone}**\n` +
                    `Current time: ${moment().tz(timezone).format('HH:mm')}`
                )],
                components: []
            });
        }
    }
}

// Channel Setup
async function handleChannelSetup(interaction) {
    try {
        const channels = interaction.guild.channels.cache
            .filter(channel => 
                channel.type === ChannelType.GuildText &&
                channel.permissionsFor(interaction.guild.members.me).has(['SendMessages', 'ViewChannel'])
            )
            .map(channel => ({
                label: channel.name,
                value: channel.id,
                description: `#${channel.name}`,
                emoji: EMOJIS.CHANNEL
            }));

        if (channels.length === 0) {
            await interaction.reply({
                embeds: [createEmbed(
                    `${EMOJIS.ERROR} No Channels Available`,
                    'No suitable channels found. Please make sure I have permissions to send messages in at least one channel.',
                    COLORS.ERROR
                )],
                ephemeral: true
            });
            return;
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('channel_select')
                    .setPlaceholder('Select reminder channel')
                    .addOptions(channels)
            );

        await interaction.reply({
            embeds: [createEmbed(
                `${EMOJIS.CHANNEL} Channel Setup`,
                'Select the channel where you want to receive reminders:'
            )],
            components: [row],
            ephemeral: true
        });
    } catch (error) {
        console.error('Channel setup error:', error);
        await interaction.reply({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} Error`,
                'An error occurred while setting up channels. Please try again.',
                COLORS.ERROR
            )],
            ephemeral: true
        });
    }
}

async function handleChannelChoice(interaction) {
    try {
        const channelId = interaction.values[0];
        await db.set(`user_${interaction.user.id}.reminderChannel`, channelId);
        const channel = interaction.guild.channels.cache.get(channelId);
        
        // Send a test message to verify permissions
        const testMessage = await channel.send({
            embeds: [createEmbed(
                `${EMOJIS.SUCCESS} Channel Test`,
                'This is a test message to verify reminder permissions.'
            )]
        });
        
        // Delete test message after 5 seconds
        setTimeout(() => testMessage.delete().catch(console.error), 5000);

        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.SUCCESS} Channel Set`,
                `Reminders will be sent to ${channel.toString()}\n` +
                'A test message has been sent and will be deleted in 5 seconds.'
            )],
            components: []
        });
    } catch (error) {
        console.error('Channel choice error:', error);
        await interaction.update({
            embeds: [createEmbed(
                `${EMOJIS.ERROR} Error`,
                'Failed to set reminder channel. Please make sure I have proper permissions.',
                COLORS.ERROR
            )],
            components: []
        });
    }
}

// Client ready event handler
client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
        await restoreReminders();
    } catch (error) {
        console.error('Error during startup:', error);
    }
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);


