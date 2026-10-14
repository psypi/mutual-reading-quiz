import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function serverConfig(env=process.env){
  const production=env.NODE_ENV==='production';
  if(production&&(!env.DATA_DIR||!isAbsolute(env.DATA_DIR)))throw new Error('배포 환경에는 영구 저장소의 절대 경로 DATA_DIR가 필요합니다. 임시 파일 시스템을 사용하지 마세요.');
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT는 1~65535 정수여야 합니다.');
  return {port,host:env.HOST||(production?'0.0.0.0':'127.0.0.1'),dataDir:env.DATA_DIR?resolve(env.DATA_DIR):fileURLToPath(new URL('./data',import.meta.url))};
}
