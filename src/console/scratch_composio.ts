import { Composio } from '@composio/core';

async function main() {
  const apiKey = 'ak_wOYh4Hmuxxknt_PSzKDf';
  const composio = new Composio({ apiKey });
  
  try {
    const session = await composio.create('karen');
    console.log('QUERYING SCHEMAS FOR VALIDATED GOOGLECALENDAR TOOLS...');
    
    const schemas = await session.execute('COMPOSIO_GET_TOOL_SCHEMAS', {
      tool_slugs: [
        'GOOGLECALENDAR_EVENTS_LIST',
        'GOOGLECALENDAR_CREATE_EVENT',
        'GOOGLECALENDAR_UPDATE_EVENT',
        'GOOGLECALENDAR_DELETE_EVENT',
        'GOOGLECALENDAR_FIND_EVENT'
      ]
    });
    
    console.dir(schemas, { depth: null });
  } catch (err: any) {
    console.error('Error fetching schemas:', err);
  }
}

main();
