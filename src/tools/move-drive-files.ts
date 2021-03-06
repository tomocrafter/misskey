import * as Minio from 'minio';
import * as uuid from 'uuid';
import * as promiseLimit from 'promise-limit';
import DriveFile, { DriveFileChunk, getDriveFileBucket, IDriveFile } from '../models/drive-file';
import DriveFileThumbnail, { DriveFileThumbnailChunk } from '../models/drive-file-thumbnail';
import config from '../config';

const limit = promiseLimit(16);

DriveFile.find({
	$or: [{
		'metadata.withoutChunks': { $exists: false }
	}, {
		'metadata.withoutChunks': false
	}],
	'metadata.deletedAt': { $exists: false }
}, {
	fields: {
		_id: true
	}
}).then(async files => {
	console.log(`there is ${files.length} files`);

	await Promise.all(files.map(file => limit(() => job(file))));

	console.log('ALL DONE');
});

async function job(file: IDriveFile): Promise<any> {
	file = await DriveFile.findOne({ _id: file._id });

	const minio = new Minio.Client(config.drive.config);

	const name = file.filename.substr(0, 50);
	const keyDir = `${config.drive.prefix}/${uuid.v4()}`;
	const key = `${keyDir}/${name}`;
	const thumbnailKeyDir = `${config.drive.prefix}/${uuid.v4()}`;
	const thumbnailKey = `${thumbnailKeyDir}/${name}.thumbnail.jpg`;

	const baseUrl = config.drive.baseUrl
		|| `${ config.drive.config.useSSL ? 'https' : 'http' }://${ config.drive.config.endPoint }${ config.drive.config.port ? `:${config.drive.config.port}` : '' }/${ config.drive.bucket }`;

	const bucket = await getDriveFileBucket();
	const readable = bucket.openDownloadStream(file._id);

	await minio.putObject(config.drive.bucket, key, readable, file.length, {
		'Content-Type': file.contentType,
		'Cache-Control': 'max-age=31536000, immutable'
	});

	await DriveFile.findOneAndUpdate({ _id: file._id }, {
		$set: {
			'metadata.withoutChunks': true,
			'metadata.storage': 'minio',
			'metadata.storageProps': {
				key: key,
				thumbnailKey: thumbnailKey
			},
			'metadata.url': `${ baseUrl }/${ keyDir }/${ encodeURIComponent(name) }`,
		}
	});

	// チャンクをすべて削除
	await DriveFileChunk.remove({
		files_id: file._id
	});

	//#region サムネイルもあれば削除
	const thumbnail = await DriveFileThumbnail.findOne({
		'metadata.originalId': file._id
	});

	if (thumbnail) {
		await DriveFileThumbnailChunk.remove({
			files_id: thumbnail._id
		});

		await DriveFileThumbnail.remove({ _id: thumbnail._id });
	}
	//#endregion

	console.log('done', file._id);
}
