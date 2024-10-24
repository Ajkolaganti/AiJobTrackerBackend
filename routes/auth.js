require('dotenv').config();
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { processWithAI,extractLatestQuestion } = require('../services/aiService');
const { cacheGet, cacheSet } = require('../services/redisService');
const axios = require('axios');

// Initialize clients and configs
const openai = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY
});
const API_URL = 'https://api.openai.com/v1/chat/completions';
const API_KEY = process.env.OPENAI_API_KEY;


const supabase = createClient(
    process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
 process.env.GOOGLE_REDIRECT_URI
);

// Google Auth Routes
router.get('/auth/google/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly']
  });
  res.json({ url });
});

router.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.redirect(`http://localhost:5173/applications?access_token=${tokens.access_token}`);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).json({ error: 'Failed to authenticate' });
  }
});

// Meeting/Interview Routes
router.post('/meeting/assist', async (req, res) => {
    const { text, userId, context = {}, fullTranscript = [] } = req.body;
    
    try {
      console.log('Received request:', { text, context });
      console.log('ApiKey:', process.env.OPENAI_API_KEY);
      console.log('Full Transcript:', fullTranscript);
      
      // Set streaming headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
  
      // Build conversation context from full transcript
      const recentExchanges = fullTranscript
        .slice(-5)  // Keep last 5 exchanges for context
        .map(t => `${t.speaker}: ${t.text}`)
        .join('\n');
  
      // Prepare interview context
      const interviewContext = {
        type: context.type || 'technical',
        role: context.role || 'Software Engineer',
        experience: context.experience || 'mid-level',
        technologies: context.technologies || [],
        company: context.company || 'the company',
        interviewStage: context.stage || 'technical interview'
      };
  
      // Create streaming completion with interview-focused prompt
      const stream = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `You are an AI assistant helping with a ${interviewContext.type} interview for a ${interviewContext.role} position at ${interviewContext.company}.
  
  Interview Context:
  - Position Level: ${interviewContext.experience}
  - Interview Stage: ${interviewContext.interviewStage}
  - Key Technologies: ${interviewContext.technologies.join(', ')}
  
  Your Role:
  1. Maintain a natural interview conversation flow
  2. Respond as an interviewer would in a real ${interviewContext.type} interview
  3. Show interest in the candidate's experience and technical depth
  4. Ask relevant follow-up questions when appropriate
  5. Keep responses professional but conversational
  6. If technical topics are discussed, ensure accurate and practical responses
  
  Recent Conversation Context:
  ${recentExchanges}
  
  Guidelines:
  - Maintain the natural flow of conversation
  - Provide specific, relevant examples when discussing technical topics
  - Keep responses focused and well-structured
  - Use appropriate technical depth based on the candidate's level
  - Be encouraging while maintaining professional assessment standards`
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.8,  // Higher temperature for more natural conversation
        max_tokens: 1000,
        stream: true,
        presence_penalty: 0.6,
        frequency_penalty: 0.4
      });
  
      // Stream handling with improved error management
      try {
        let accumulatedResponse = '';
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            accumulatedResponse += content;
            
            // Send chunk to client with metadata
            res.write(`data: ${JSON.stringify({
              content,
              type: 'content',
              timestamp: new Date().toISOString(),
              metadata: {
                interviewType: interviewContext.type,
                role: interviewContext.role
              }
            })}\n\n`);
          }
        }
  
        // Save the interaction to the database if needed
        await saveInteraction({
          userId,
          input: text,
          response: accumulatedResponse,
          context: interviewContext,
          timestamp: new Date()
        });
  
      } catch (streamError) {
        console.error('Streaming error:', streamError);
        res.write(`data: ${JSON.stringify({
          error: 'Streaming error occurred',
          type: 'error',
          message: streamError.message,
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
  
      // Send completion signal with summary
      res.write(`data: ${JSON.stringify({ 
        done: true,
        type: 'completion',
        timestamp: new Date().toISOString()
      })}\n\n`);
      res.end();
  
    } catch (error) {
      console.error('Interview assistance error:', error);
      res.status(500).json({
        error: 'Failed to provide interview assistance',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

// Meeting transcription
router.post('/meeting/transcribe', async (req, res) => {
  const { audioData, userId } = req.body;
  
  try {
    const { data: userTokens } = await supabase
      .from('user_tokens')
      .select('access_token')
      .eq('user_id', userId)
      .single();

    if (!userTokens) {
      throw new Error('User tokens not found');
    }

    // Setup Speech-to-Text
    const speechClient = new google.speech({
      version: 'v1',
      auth: oauth2Client
    });

    const request = {
      audio: { content: audioData },
      config: {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
        model: 'latest_long'
      }
    };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    // Store in Supabase
    await supabase
      .from('meeting_transcripts')
      .insert({
        user_id: userId,
        transcript: transcription,
        created_at: new Date().toISOString()
      });

    res.json({ transcript: transcription });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

router.post('/generate-resume-cover-letter', async (req, res) => {
    const { jobTitle, company, jobPostingUrl, existingResume } = req.body;
  
    try {
      // Fetch job description if needed
      let jobDescription = '';
      if (jobPostingUrl) {
        const response = await axios.get(jobPostingUrl);
        jobDescription = response.data; // Adjust extraction as needed
      }
  
      const messages = [
        { role: 'system', content: 'You are an expert resume writer and career coach.' },
        {
          role: 'user',
          content: `Create a tailored resume for a ${jobTitle} position at ${company}.
          Job Description: ${jobDescription}
          ${existingResume ? `Existing Resume: ${existingResume}` : 'Please create a new resume from scratch.'}
  
          Please format the resume in Markdown.`,
        },
        {
          role: 'user',
          content: `Now, create a cover letter for the same position.
          Address it to the hiring manager at ${company}.
  
          Please format the cover letter in Markdown.`,
        },
      ];
  
      const response = await axios.post(
        API_URL,
        {
          model: 'gpt-4o',
          messages: messages,
          max_tokens: 2000,
          temperature: 0.7,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
          },
        }
      );
  
      const generatedContent = response.data.choices[0].message.content;
      const [resume, coverLetter] = generatedContent.split('Now, create a cover letter for the same position.');
  
      res.json({
        resume: resume.trim(),
        coverLetter: coverLetter ? coverLetter.trim() : '',
      });
    } catch (error) {
      console.error('Error generating content:', error);
      res.status(500).json({ error: 'Error generating content' });
    }
  });
  
  // Enhance Text using AI
  router.post('/enhance-text', async (req, res) => {
    const { text } = req.body;
    console.log('APIKEY::::',process.env.OPENAI_API_KEY)
    console.log('TEXT::::',text)
  
    try {
      const messages = [
        {
          role: 'system',
          content:
            'You are a professional resume writer specializing in enhancing resumes. Provide only the enhanced text without any introductory or concluding remarks, instructions, or formatting. Do not include any markdown or additional comments.',
        },
        {
          role: 'user',
          content: `Please enhance the following text to make it more impactful and professional, ensuring it appears to be written by a human:
  
  "${text}"`,
        },
      ];
  
      const response = await axios.post(
        API_URL,
        {
          model: 'gpt-4o',
          messages: messages,
          max_tokens: 500,
          temperature: 0.7,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
          },
        }
      );
  
      const enhancedText = response.data.choices[0].message.content.trim();
  
      res.json({ enhancedText });
    } catch (error) {
      console.error('Error enhancing text:', error);
      res.status(500).json({ error: 'Error enhancing text' });
    }
  });
  
  // Get Chat Response
  router.post('/get-chat-response', async (req, res) => {
    const { userMessage } = req.body;
  
    try {
      const messages = [
        {
          role: 'system',
          content: 'You are an AI assistant specialized in job search and interview preparation. Provide helpful, concise advice to users.',
        },
        { role: 'user', content: userMessage },
      ];
  
      const response = await axios.post(
        API_URL,
        {
          model: 'gpt-4o',
          messages: messages,
          max_tokens: 150,
          temperature: 0.7,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
          },
        }
      );
  
      const aiResponse = response.data.choices[0].message.content.trim();
      res.json({ aiResponse });
    } catch (error) {
      console.error('Error getting chat response:', error);
      res.status(500).json({ error: 'Error getting chat response' });
    }
  });
  
  // Tailor Resume
  router.post('/tailor-resume', async (req, res) => {
    const { resumeContent, jobDescription, jobTitle = '', company = '' } = req.body;
  console.log('request received')
    // Input validation
    if (!resumeContent || !jobDescription) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Both resume content and job description are required'
      });
    }
  
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are an expert resume consultant with 15+ years of experience in professional resume writing and ATS optimization. Your task is to enhance and tailor resumes while maintaining authenticity and human writing style.
  
  KEY REQUIREMENTS:
  
  1. Content Optimization:
     - Identify and emphasize experiences matching the job requirements
     - Use industry-specific keywords naturally
     - Quantify achievements with metrics (%, $, numbers)
     - Follow STAR method (Situation, Task, Action, Result)
     - Maintain authenticity - never fabricate experiences
     - Highlight transferable skills relevant to the role
     - Ensure proper career progression visibility
  
  2. Professional Writing Standards:
     - Use appropriate action verbs for career level:
       * Entry: Assisted, Supported, Participated
       * Mid-level: Managed, Led, Developed
       * Senior: Architected, Spearheaded, Pioneered
     - Write in active voice
     - Remove filler words and redundancies
     - Keep descriptions concise and impactful
     - Maintain professional tone throughout
  
  3. ATS Optimization:
     - Incorporate job description keywords naturally
     - Use standard section headings
     - Maintain ATS-friendly formatting
     - Include relevant technical terms
     - Match job title terminology
  
  4. Format Requirements:
     - Preserve ALL original formatting exactly:
       * Spacing and indentation
       * Bullet points and symbols
       * Section order and hierarchy
       * Special characters
     - Return content in identical format
     - Maintain consistent styling
  
  5. Quality Standards:
     Each bullet point must:
     - Begin with strong action verb
     - Include specific achievement/metric
     - Demonstrate clear impact
     - Remain realistic and verifiable
  
  STRICT RULES:
  - Never add fictional experiences
  - Remove generic phrases ("responsible for")
  - Eliminate personal pronouns
  - Cut outdated/irrelevant content
  - Maintain exact original formatting
  - Focus on relevant achievements
  
  RETURN ONLY THE ENHANCED RESUME CONTENT WITH EXACT ORIGINAL FORMATTING. NO EXPLANATIONS OR COMMENTS.`
          },
          {
            role: "user",
            content: `Please tailor this resume for a ${jobTitle} position at ${company}.
  
  JOB DESCRIPTION:
  ${jobDescription}
  
  ORIGINAL RESUME:
  ${resumeContent}
  
  Enhance the content while maintaining the exact original formatting and structure.`
          }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        presence_penalty: 0.2,
        frequency_penalty: 0.3
      });
  
      const tailoredResume = completion.choices[0]?.message?.content?.trim();
  
      // Validate the response
      if (!tailoredResume) {
        throw new Error('No resume content generated');
      }
  
      // Send successful response
      res.json({
        tailoredResume,
        metadata: {
          targetPosition: jobTitle || 'Not specified',
          targetCompany: company || 'Not specified',
          originalLength: resumeContent.length,
          enhancedLength: tailoredResume.length,
          timestamp: new Date().toISOString()
        }
      });
  
    } catch (error) {
      console.error('Resume tailoring error:', {
        message: error.message,
        code: error.code,
        type: error.type,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
  
      // Handle specific error cases
      let statusCode = 500;
      let errorMessage = 'Error tailoring resume';
  
      if (error.response?.status === 429) {
        statusCode = 429;
        errorMessage = 'Rate limit exceeded. Please try again later.';
      } else if (error.response?.status === 401) {
        statusCode = 401;
        errorMessage = 'Authentication error';
      } else if (error.message.includes('max_tokens')) {
        statusCode = 400;
        errorMessage = 'Resume too long to process';
      }
  
      res.status(statusCode).json({
        error: errorMessage,
        message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred while processing your request',
        timestamp: new Date().toISOString()
      });
    }
  });

  router.get('/tailor-resume/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      apiAvailable: !!process.env.OPENAI_API_KEY
    });
  });
  
  
  // Get Google Auth URL
  router.get('/auth/google/url', (req, res) => {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
  
    res.json({ url: authUrl });
  });
  
  // Fetch Jobs from Email
  router.post('/fetch-jobs-from-email', async (req, res) => {
    const { userId, accessToken } = req.body;
  
    // Implement your logic to fetch jobs from email
    res.json({ jobs: [] });
  });

module.exports = router;