import { PlatformDatabase } from '../../src/database.js';
import { WorkspaceService } from '../../src/workspace.js';
import { UploadService } from '../../src/uploads.js';
const [filename, userId, sessionId, quota] = process.argv.slice(2);
const database = new PlatformDatabase(filename);
const uploads = new UploadService({ database, workspace: new WorkspaceService(database), config: { uploads: JSON.parse(quota) } });
process.send({ ready: true });
process.once('message', async () => {
  try {
    await uploads.uploadAsync({ userId: Number(userId), sessionId: Number(sessionId), name: `${process.pid}.csv`, contentBase64: Buffer.from('code,amount\na,1\n').toString('base64') });
    process.send({ status: 'fulfilled' });
  } catch (error) { process.send({ status: 'rejected', code: error.code, message: error.message }); }
  finally { database.close(); process.disconnect(); }
});
