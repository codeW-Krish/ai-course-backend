// Quick inspection script
async function main() {
  const r1 = await fetch('http://localhost:3030/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email:'testuser@example.com', password:'Test123456'})
  });
  const login = await r1.json();
  const token = login.accessToken;
  console.log('Got token:', token?.slice(0,20) + '...');

  const r2 = await fetch('http://localhost:3030/api/courses/0h3kYLU0rXWDAB77Gigx/full', {
    headers: {Authorization: 'Bearer ' + token}
  });
  const full = await r2.json();
  console.log('Top-level keys:', Object.keys(full));
  const course = full.course || full;
  console.log('Course keys:', Object.keys(course));
  const unitKey = course.units ? 'units' : course.modules ? 'modules' : 'none';
  console.log('Units key:', unitKey, 'count:', course[unitKey]?.length);
  
  if (course.units?.length > 0) {
    const u = course.units[0];
    console.log('Unit[0] keys:', Object.keys(u));
    console.log('Unit[0] subtopics:', u.subtopics?.length);
    if (u.subtopics?.[0]) {
      const s = u.subtopics[0];
      console.log('Subtopic[0].id:', s.id);
      console.log('Subtopic[0].title:', s.title);
      console.log('Subtopic[0] has content:', !!s.content);
    }
  }

  // Also test audio route
  console.log('\n--- Audio route test ---');
  const audioR = await fetch(`http://localhost:3030/api/audio/course/0h3kYLU0rXWDAB77Gigx`, {
    headers: {Authorization: 'Bearer ' + token}
  });
  const audioD = await audioR.json().catch(() => audioR.text());
  console.log('Audio course route status:', audioR.status);
  console.log('Audio response:', JSON.stringify(audioD).slice(0, 200));

  // Gamification ping test
  console.log('\n--- Gamification ping test ---');
  const pingR = await fetch('http://localhost:3030/api/gamification/activity/ping', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
    body: JSON.stringify({activity_type: 'test_ping'})
  });
  const pingD = await pingR.json();
  console.log('Ping status:', pingR.status, 'message:', pingD.message);
  console.log('Ping stats:', JSON.stringify(pingD.stats).slice(0, 200));
}

main().catch(e => console.error('Error:', e));
