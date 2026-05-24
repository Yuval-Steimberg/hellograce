const USER_MESSAGE_SYSTEM = `You are simulating a real person texting an AI health companion on WhatsApp.
You must stay perfectly in character. Generate ONLY the user's next message — nothing else.
Do NOT include quotation marks, labels, or prefixes. Just the raw message text as the user would type it.`;
function buildUserPrompt(persona, scenario, conversationSoFar, turnIndex, totalTurns) {
    const parts = [];
    parts.push(`CHARACTER:
Name: ${persona.name}, age ${persona.age}
Medication: ${persona.medication} (${persona.medicationType})
Week ${persona.weekOnGlp1} on GLP-1
Goals: ${persona.goals.join(', ')}
Communication style: ${persona.communicationStyle}
Personality: ${persona.personalityTraits.join(', ')}
Typical issues: ${persona.typicalIssues.join(', ')}
Backstory: ${persona.backstory}`);
    if (persona.dietaryRestriction) {
        parts.push(`Dietary restriction: ${persona.dietaryRestriction}`);
    }
    if (persona.foodDislikes?.length) {
        parts.push(`Food dislikes: ${persona.foodDislikes.join(', ')}`);
    }
    if (persona.weight) {
        parts.push(`Weight: ${persona.weight.current} lbs → goal ${persona.weight.goal} lbs`);
    }
    parts.push(`\nSCENARIO: ${scenario.description}`);
    parts.push(`CHALLENGES TO TEST: ${scenario.challenges.join(', ')}`);
    if (scenario.setup) {
        parts.push(`SETUP CONTEXT: ${scenario.setup}`);
    }
    parts.push(`\nTurn ${turnIndex + 1} of ${totalTurns}.`);
    if (turnIndex === 0) {
        parts.push('This is the FIRST message in the conversation. The user initiates.');
    }
    else {
        parts.push('\nCONVERSATION SO FAR:');
        for (const turn of conversationSoFar) {
            const label = turn.role === 'user' ? persona.name : 'Grace';
            parts.push(`${label}: ${turn.text}`);
        }
        parts.push(`\nGenerate ${persona.name}'s NEXT message, staying in character.`);
    }
    // Style-specific instructions
    switch (persona.communicationStyle) {
        case 'terse':
            parts.push('\nKEEP IT SHORT. 1-5 words. No full sentences. Maybe abbreviations.');
            break;
        case 'emoji-heavy':
            parts.push('\nUse 2-4 emojis naturally in the message.');
            break;
        case 'verbose':
            parts.push('\nWrite 2-4 sentences. Include details and feelings.');
            break;
        case 'anxious':
            parts.push('\nShow worry or uncertainty. Maybe ask follow-up questions. Use hedging language.');
            break;
        case 'formal':
            parts.push('\nUse proper grammar and complete sentences. Polite and measured.');
            break;
        case 'casual':
            parts.push('\nWrite like a normal text message. Lowercase ok. Casual tone.');
            break;
    }
    // Progressive challenges
    if (turnIndex > 0 && turnIndex === Math.floor(totalTurns / 2)) {
        parts.push('\nAt this midpoint, introduce one of the scenario challenges. Maybe switch topic, add a correction, or escalate emotionally.');
    }
    if (turnIndex === totalTurns - 1) {
        parts.push('\nThis is the FINAL user message. Wrap up naturally or leave with a short closing.');
    }
    return parts.join('\n');
}
export async function generateUserMessage(llm, persona, scenario, conversationSoFar, turnIndex, totalTurns) {
    const resp = await llm.generate({
        messages: [
            { role: 'system', content: USER_MESSAGE_SYSTEM },
            {
                role: 'user',
                content: buildUserPrompt(persona, scenario, conversationSoFar, turnIndex, totalTurns),
            },
        ],
        temperature: 0.85,
        maxOutputTokens: 300,
    });
    return resp.text.trim().replace(/^["']|["']$/g, '');
}
