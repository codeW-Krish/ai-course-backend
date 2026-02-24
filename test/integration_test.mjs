// Quick integration test for course outline generation
import fetch from 'node-fetch';

const BASE = 'http://localhost:3030';

async function test() {
  console.log('=== Integration Test ===\n');

  // 1. Login
  console.log('1. Logging in...');
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'testuser@example.com', password: 'Test123456' })
  });
  const loginData = await loginRes.json();
  console.log(`   Status: ${loginRes.status}`);
  
  if (!loginData.accessToken) {
    console.log('   Login failed:', loginData);
    process.exit(1);
  }
  const token = loginData.accessToken;
  console.log(`   Token: ${token.slice(0,30)}...`);
  console.log(`   User: ${loginData.user?.username} (${loginData.user?.id})\n`);

  // 2. Get public courses
  console.log('2. Fetching public courses...');
  const coursesRes = await fetch(`${BASE}/api/courses`);
  const coursesData = await coursesRes.json();
  console.log(`   Status: ${coursesRes.status}`);
  console.log(`   Found: ${coursesData.courses?.length || 0} courses\n`);

  // 3. Get my courses
  console.log('3. Fetching my courses...');
  const myCoursesRes = await fetch(`${BASE}/api/courses/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const myCoursesData = await myCoursesRes.json();
  console.log(`   Status: ${myCoursesRes.status}`);
  console.log(`   My courses: ${myCoursesData.myCourses?.length || 0}\n`);

  // 4. Generate outline  
  console.log('4. Generating course outline (Gemini)...');
  const outlineRes = await fetch(`${BASE}/api/courses/generate-outline`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}` 
    },
    body: JSON.stringify({
      title: 'Introduction to Python Programming',
      description: 'A comprehensive beginner course covering Python basics, data types, control flow, functions, and simple projects.',
      numUnits: 2,
      difficulty: 'Beginner',
      includeVideos: false,
      provider: 'Gemini'
    })
  });

  console.log(`   Status: ${outlineRes.status}`);
  
  if (outlineRes.status === 201) {
    const outlineData = await outlineRes.json();
    console.log(`   Course ID: ${outlineData.courseId}`);
    console.log(`   Outline status: ${outlineData.status}`);
    console.log(`   Course title: ${outlineData.outline?.course_title}`);
    console.log(`   Units: ${outlineData.outline?.units?.length}`);
    
    for (const unit of (outlineData.outline?.units || [])) {
      console.log(`     Unit ${unit.position}: ${unit.title}`);
      for (const sub of (unit.subtopics || [])) {
        console.log(`       - ${sub}`);
      }
    }
    
    console.log('\n5. Fetching full course...');
    const fullRes = await fetch(`${BASE}/api/courses/${outlineData.courseId}/full`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`   Status: ${fullRes.status}`);
    if (fullRes.status === 200) {
      const fullData = await fullRes.json();
      console.log(`   Course title: ${fullData.course?.title}`);
      console.log(`   Units: ${fullData.units?.length}`);
    } else {
      const errData = await fullRes.json().catch(() => ({}));
      console.log(`   Error: ${JSON.stringify(errData)}`);
    }
  } else {
    const errData = await outlineRes.text();
    console.log(`   Error: ${errData}`);
  }

  console.log('\n=== Test Complete ===');
}

test().catch(e => {
  console.error('Test error:', e.message);
  process.exit(1);
});
