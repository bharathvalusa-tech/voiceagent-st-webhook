const config = require('../config/environment');

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-5.4-nano';

/**
 * Uses GPT to pick the best matching location when an address search returns
 * multiple candidates and the caller provided a location or company name.
 *
 * Returns the locationId of the best match, or null if GPT cannot decide.
 */
const disambiguateLocations = async (candidates, callerContext) => {
    if (!config.openaiApiKey) {
        return null;
    }

    const locationList = candidates.map((c, i) => ({
        index: i + 1,
        locationId: c.locationId,
        locationName: c.locationName || 'N/A',
        companyName: c.companyName || 'N/A',
        address: c.address
            ? `${c.address.street || ''}, ${c.address.city || ''}, ${c.address.state || ''} ${c.address.postalCode || ''}`.trim()
            : 'N/A'
    }));

    const systemPrompt = `You are a location matching assistant. A caller has provided a location name or company name over the phone. You need to pick which ServiceTrade location they are referring to from a list of candidates at the same address.

Important considerations:
- Numbers may be spoken as words (e.g., "Sixteen Hundred" = "1600", "Three Hundred" = "300")
- Speech-to-text may introduce minor spelling variations
- The caller might say the location name, the company name, or the building name — any of these could match
- If no candidate is a clear match, respond with "none"

Respond with ONLY a JSON object in this exact format:
{"match": <index number>} or {"match": "none"}

Do NOT include any other text.`;

    const userPrompt = `The caller provided:
- Location/Building name: "${callerContext.locationName || 'not provided'}"
- Company name: "${callerContext.companyName || 'not provided'}"
- Address: "${callerContext.address || 'not provided'}"

Candidates:
${locationList.map((loc) => `${loc.index}. Location: "${loc.locationName}" | Company: "${loc.companyName}" | Address: ${loc.address}`).join('\n')}

Which candidate best matches what the caller said?`;

    try {
        const response = await fetch(OPENAI_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.openaiApiKey}`
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_completion_tokens: 50
            })
        });

        if (!response.ok) {
            console.error(`[GPT_DISAMBIGUATION] OpenAI API error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const content = (data.choices?.[0]?.message?.content || '').trim();

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (parseErr) {
            console.error(`[GPT_DISAMBIGUATION] Failed to parse GPT response: ${content}`);
            return null;
        }

        if (parsed.match === 'none' || parsed.match == null) {
            return null;
        }

        const matchIndex = Number(parsed.match);
        if (Number.isNaN(matchIndex) || matchIndex < 1 || matchIndex > candidates.length) {
            console.error(`[GPT_DISAMBIGUATION] Invalid match index: ${parsed.match}`);
            return null;
        }

        const selected = candidates[matchIndex - 1];
        return {
            locationId: selected.locationId,
            locationName: selected.locationName,
            companyName: selected.companyName,
            matchIndex,
            gptResponse: content
        };
    } catch (error) {
        console.error(`[GPT_DISAMBIGUATION] Error calling OpenAI: ${error.message}`);
        return null;
    }
};

module.exports = { disambiguateLocations };
