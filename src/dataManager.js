const fs = require('fs').promises;
const path = require('path');

class DataManager {
    constructor() {
        this.dataPath = path.join(__dirname, '..', 'data', 'userData.json');
    }

    async ensureDataFile() {
        try {
            await fs.access(this.dataPath);
        } catch {
            const initialData = { users: {} };
            await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
            await fs.writeFile(this.dataPath, JSON.stringify(initialData, null, 2));
        }
    }

    async loadData() {
        await this.ensureDataFile();
        const data = await fs.readFile(this.dataPath, 'utf8');
        return JSON.parse(data);
    }

    async saveData(data) {
        await fs.writeFile(this.dataPath, JSON.stringify(data, null, 2));
    }
}

module.exports = DataManager;
