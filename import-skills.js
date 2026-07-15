import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const srcDir = 'C:\\Users\\matbr\\claudecode1\\_zip_contents\\everything-claude-code-main\\skills';
const destFile = 'C:\\Users\\matbr\\atlas\\data\\skills.json';

async function run() {
  const folders = await fs.readdir(srcDir, { withFileTypes: true });
  const skills = [];

  for (const f of folders) {
    if (!f.isDirectory() || f.name === 'references' || f.name === 'commands' || f.name === 'hooks' || f.name === 'agents' || f.name === 'assets' || f.name === 'rules' || f.name === 'scripts' || f.name === 'fixtures' || f.name === 'prompts' || f.name === 'tests' || f.name === 'reference') continue;
    
    const skillMdPath = path.join(srcDir, f.name, 'SKILL.md');
    try {
      const content = await fs.readFile(skillMdPath, 'utf8');
      
      // Parse YAML frontmatter
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      let name = f.name.replace(/-/g, ' ');
      let description = '';
      let systemPrompt = content;

      if (match) {
        const yamlStr = match[1];
        systemPrompt = match[2];
        const nameMatch = yamlStr.match(/^name:\s*(.+)$/m);
        const descMatch = yamlStr.match(/^description:\s*>-\r?\n\s*([\s\S]*?)(?=\n[a-z]|$)/m) || yamlStr.match(/^description:\s*(.+)$/m);
        
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      }

      skills.push({
        id: crypto.randomUUID(),
        name: name,
        category: "imported",
        description: description || `Imported skill from ${f.name}`,
        systemPrompt: systemPrompt.trim(),
        inputHint: "Enter details for the task",
        createdAt: new Date().toISOString(),
        timesRun: 0
      });
      console.log(`Parsed skill: ${name}`);
    } catch (err) {
      // Some folders might not have SKILL.md
    }
  }

  // Load existing skills if they exist to prevent duplicates
  let existingSkills = [];
  try {
    const existingContent = await fs.readFile(destFile, 'utf8');
    existingSkills = JSON.parse(existingContent);
  } catch (err) {
    // File doesn't exist yet
  }

  const existingNames = new Set(existingSkills.map(s => s.name.toLowerCase()));
  const newSkills = [...existingSkills];

  for (const s of skills) {
    if (!existingNames.has(s.name.toLowerCase())) {
      newSkills.push(s);
    }
  }

  // Write to destination
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  await fs.writeFile(destFile, JSON.stringify(newSkills, null, 2), 'utf8');
  console.log(`Successfully imported ${newSkills.length - existingSkills.length} new skills! Total skills: ${newSkills.length} inside ${destFile}`);
}

run().catch(console.error);
