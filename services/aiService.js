
require('dotenv').config();const OpenAI = require('openai');


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function extractLatestQuestion(text) {
    // Clean up the text first
    const cleanText = text
      .replace(/\s+/g, ' ')  // normalize whitespace
      .trim();
    
    // Split into potential questions using multiple delimiters
    const questionPatterns = [
      /(?:^|\s)what\s+.*?\?/gi,
      /(?:^|\s)how\s+.*?\?/gi,
      /(?:^|\s)why\s+.*?\?/gi,
      /(?:^|\s)when\s+.*?\?/gi,
      /(?:^|\s)where\s+.*?\?/gi,
      /(?:^|\s)which\s+.*?\?/gi,
      /(?:^|\s)can\s+.*?\?/gi,
      /(?:^|\s)could\s+.*?\?/gi,
      /(?:^|\s)what\s+.*?(?=\s+what|\s+how|\s+why|\s+when|\s+where|\s+which|\s+can|\s+could|$)/gi,
      /(?:^|\s)how\s+.*?(?=\s+what|\s+how|\s+why|\s+when|\s+where|\s+which|\s+can|\s+could|$)/gi,
    ];
  
    let questions = [];
    
    // Extract all questions using patterns
    questionPatterns.forEach(pattern => {
      const matches = cleanText.match(pattern);
      if (matches) {
        questions.push(...matches.map(q => q.trim()));
      }
    });
  
    // Filter out duplicates and sort by position in original text
    questions = [...new Set(questions)]
      .map(q => ({
        question: q,
        position: cleanText.lastIndexOf(q)
      }))
      .sort((a, b) => b.position - a.position);
  
    // Return the question that appears last in the text
    return questions.length > 0 ? questions[0].question : null;
  }

// Function to extract the latest question from transcript
async function processWithAI(text, context = {}, fullTranscript = [], stream = true) {
    try {
        const sanitizedText = String(text || '').trim();
        if (!sanitizedText) {
            throw new Error('Input text is required');
        }
        console.log('inside processWithAI Input text:', sanitizedText);


        // Build conversation history
        let conversationContext = '';
        if (Array.isArray(fullTranscript)) {
            const recentTranscripts = fullTranscript.slice(-5); // Keep last 5 exchanges
            conversationContext = recentTranscripts
                .map(t => `${t.speaker}: ${t.text}`)
                .join('\n');
        }

        // Customize context based on interview type
        const interviewType = context.type || 'technical';
        const role = context.role || 'Software Engineer';
        const experience = context.experience || 'mid-level';
        const specificTech = context.technologies || [];

        const messages = [
            {
                role: "system",
                content: `You are an AI assistant helping prepare for a ${interviewType} interview for a ${role} position.

Interview Context:
- Position Level: ${experience}
- Key Technologies: ${specificTech.join(', ')}

Your Role:
1. Act as if you're in a real interview conversation. The human is the candidate, and you should respond as if you're having a natural back-and-forth discussion.
2. Treat all inputs (whether questions or statements) as part of the interview flow
3. If the candidate mentions specific technologies or experiences, engage with follow-up details while maintaining interview context
4. Keep the tone professional but conversational, similar to a real interview
5. If appropriate, gently probe for deeper technical understanding or ask relevant follow-up questions

Previous conversation for context:
${conversationContext}

Remember: This is a natural conversation flow. The candidate might make statements, ask questions, or provide examples. Respond appropriately while maintaining the interview context.`
            },
            {
                role: "user",
                content: sanitizedText
            }
        ];

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages,
            temperature: 0.8,  // Higher temperature for more natural conversation
            max_tokens: 400,   // Longer responses for detailed answers
            presence_penalty: 0.6,
            frequency_penalty: 0.4,
            stream
        });

        if (stream) {
            return response;
        }

        const answer = response.choices[0]?.message?.content || 'No response generated';

        return {
            input: sanitizedText,
            response: answer,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('AI Processing error:', error);
        throw new Error('Failed to generate interview response: ' + error.message);
    }
}

// Example usage:
const sampleContext = {
    type: 'technical',
    role: 'Senior Software Engineer',
    experience: 'senior',
    technologies: ['Spring Boot', 'Microservices', 'Kubernetes', 'React']
};

const exampleUsage = async () => {
    try {
        const result = await processWithAI(
            "So have you had any experience working on let's say, springboard Microservices",
            sampleContext,
            [
                { speaker: "Interviewer", text: "Tell me about your background." },
                { speaker: "Candidate", text: "I've been working as a software engineer for 5 years, primarily with Java and Spring Boot." }
            ],
            false
        );
        console.log(result);
    } catch (error) {
        console.error(error);
    }
};

module.exports = {
    processWithAI,
    extractLatestQuestion
};