export default async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello from add-item!' }),
  };
};