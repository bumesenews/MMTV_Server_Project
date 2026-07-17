const fs = require('fs');
const path = require('path');

/**
 * Simple atomic JSON file store for admin state on AWS local disk.
 * GitHub is NOT used as a database — only config + Flutter JSON delivery.
 */
class JsonStore {
  constructor(filePath, defaultValue = {}) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.ensureParent();
  }

  ensureParent() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.write(this.defaultValue);
        return structuredClone(this.defaultValue);
      }
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return structuredClone(this.defaultValue);
    }
  }

  write(data) {
    this.ensureParent();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    return data;
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(current) || current;
    return this.write(next);
  }
}

module.exports = { JsonStore };
