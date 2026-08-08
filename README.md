# Indus AI — Public Deployment Guide (Gemini + Supabase)

## Step 1: Gemini API key lo (FREE, koi card nahi chahiye)
1. https://aistudio.google.com/apikey pe jaao
2. Google account se sign in karo
3. "Create API Key" dabao, key copy karke safe save kar lo (AIza... se shuru hogi)

## Step 2: Supabase database banao (FREE) — taaki sab sawal-jawab dekh sako
1. https://supabase.com pe jaao, "Start your project" se sign up karo (GitHub se bhi ho sakta hai)
2. "New Project" banao — naam kuch bhi do (e.g. `indus-ai-db`), ek password set karega (save kar lena), region "South Asia (Mumbai)" chuno agar option ho
3. Project ban jaane ke baad, left side me **"SQL Editor"** pe jaao
4. Neeche di gayi SQL copy karke paste karo aur "Run" dabao — isse table ban jayega jahan sab sawal-jawab save honge:

```sql
create table messages (
  id bigint generated always as identity primary key,
  created_at timestamp with time zone default now(),
  user_question text,
  ai_answer text
);
alter table messages disable row level security;
```

5. Ab left side me **"Project Settings" → "API"** pe jaao
6. Do cheezein copy karo:
   - **Project URL** (jaise `https://xxxxx.supabase.co`)
   - **service_role key** (lambi si string, "Reveal" dabana padega dikhne ke liye)

⚠️ service_role key kabhi kisi ko mat dena, ye tumhari database ki full access key hai.

## Step 3: GitHub pe code daalo
1. https://github.com pe account banao
2. Naya repository banao (e.g. `indus-ai`)
3. Is folder ki files (`index.html`, `api/chat.js`, `package.json`) upload kar do — "Add file → Upload files"

## Step 4: Vercel pe deploy karo
1. https://vercel.com pe GitHub se sign up karo
2. "Add New → Project" → apni `indus-ai` repo import karo
3. Deploy se pehle "Environment Variables" me teen cheezein daalo:
   - `GEMINI_API_KEY` → Step 1 wali key
   - `SUPABASE_URL` → Step 2 ka Project URL
   - `SUPABASE_KEY` → Step 2 ki service_role key
4. "Deploy" dabao — public link mil jayega

## Step 5: Sab sawal-jawab dekhna hai to
1. supabase.com pe apne project me jaao
2. Left side "Table Editor" pe click karo
3. `messages` table kholo — yahan **sab logo ke sawal aur AI ke jawab list me dikhenge**, mobile se bhi dekh sakte ho

## Step 6: Contact/Feedback table banao (taaki complaints bhi dikhein)
1. Supabase me **"SQL Editor"** pe jaao
2. Ye SQL paste karke Run karo:

```sql
create table feedback (
  id bigint generated always as identity primary key,
  created_at timestamp with time zone default now(),
  contact_name text,
  message text
);
alter table feedback disable row level security;
```

3. Ab website ke sidebar me **"Contact / Feedback"** button se jo bhi message aayega, wo **Table Editor → feedback** table me dikhega

## Free tier ki limits
- Gemini: roz ki quota hoti hai, bahut heavy use pe limit lag sakti hai
- Supabase: free tier me 500 MB tak database free hai — normal use ke liye kaafi hai

## Agar kuch atka
- Table Editor me kuch na dikhe → check karo Vercel ke Environment Variables sahi se daale hain (spelling exact match honi chahiye: `SUPABASE_URL`, `SUPABASE_KEY`)
- "500 error" → sabse pehle Gemini key check karo, phir Supabase
